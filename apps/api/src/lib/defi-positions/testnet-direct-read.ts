/**
 * The direct-contract-read DeFi-detection path (architecture.md §7.1, issue #148). OctoPos is
 * mainnet only - its own OpenAPI spec claims a testnet host, but that host doesn't resolve (see
 * the note on `OCTOPOS_API_URL_MAINNET` in config/networks.ts) - so testnet positions are read
 * directly over RPC `getLedgerEntries` against the contracts in the versioned contract registry
 * (lib/contract-registry), with the same "halt on unknown wasmHash, never decode against a shape
 * you haven't confirmed" discipline the exit adapters hold to (architecture.md §9.9), even though
 * this path builds nothing signable - it only reads.
 *
 * Network-parameterized rather than testnet-only: issue #149's degraded mode reuses this exact
 * function for a mainnet OctoPos outage, so the same code every testnet CI run already exercises
 * is what actually runs during a real outage, instead of a separate, rarely-exercised stub. On
 * testnet this is the designed primary path (not a fallback); on mainnet it is a best-effort
 * fallback the resolver (`resolve-defi-positions.ts`) only reaches for when OctoPos fails.
 *
 * Deliberately narrower than OctoPos's coverage: every gap below is a stated, sourced limit, not
 * a silently missing feature.
 *  - Blend: pool supply/borrow from the pool's `Positions(user)`, and the account's deposit in
 *    the pool's backstop from `UserBalance(pool, user)` on the registry's backstop contract (shares
 *    plus every queued withdrawal), reported as a supply position with `isBackstop` on the pool it
 *    backs, the way OctoPos reports it on mainnet.
 *  - Soroswap: pairs are enumerated from the factory and their SEP-41 share balances read; see
 *    readSoroswapFactoryPairs.
 *  - Aquarius: pools are enumerated from the router and each pool's separate share token read;
 *    see readAquariusRouterPools. Concentrated-liquidity pools (tick-range positions, no share
 *    token) are not read here.
 *  - Phoenix: a registered pool's `CONFIG` names its `share_token`, a separate SEP-41 contract,
 *    and its `stake_contract`. The account's LP shares are that token's `Balance(Address)`, and
 *    its stakes the stake contract's `BondingInfo`, read together; see readPhoenixPosition.
 *
 * ScVal key encoding: a soroban-sdk `#[contracttype]` enum's tuple variant with fields
 * `Variant(A)` encodes as `ScVec[Symbol("Variant"), A]`, and `Variant((A, B))` (a single field
 * whose type is itself the tuple `(A, B)`) encodes as `ScVec[Symbol("Variant"), ScVec[A, B]]` -
 * mechanically derived from each protocol's declared field shape, not assumed. Value decoding
 * uses `scValToNative`, which handles the Map/Vec distinction generically, so the key is the only
 * part this module has to construct by hand.
 */

import { UserBalance } from "@blend-capital/blend-sdk";
import { Address, Contract, hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import {
  codeRefOf,
  resolveCodeRefs,
  type CodeIdentity,
  type CodeRef,
  type LedgerEntriesReader,
} from "@/lib/stellar/contract-instance";
import {
  codeMatchesEntry,
  entriesForNetwork,
  type ContractRegistryEntry,
} from "@/lib/contract-registry";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  DefiPositionsResult,
  AquariusLpPosition,
  AquariusPoolType,
  FxdaoCdpPosition,
  Network,
  PhoenixLpPosition,
  PhoenixStakePosition,
  SoroswapLpPosition,
  UnrecognizedDefiPosition,
} from "@lumenwipe/types";
import { contractDataEntry, instanceOfEntry } from "@/lib/stellar/contract-data";
import { fxdaoCurrencyContract, fxdaoDenominations } from "@/lib/defi-exits/fxdao";
import {
  bondingInfoKey,
  phoenixConfigKey,
  phoenixShareToken,
  phoenixStakeContract,
  stakesFrom,
} from "@/lib/defi-exits/phoenix";

type RpcServer = ReturnType<typeof getRpcServer>;

// Blend ships its own copy of the Stellar SDK, so its XDR objects only cross over as bytes.
const backstopBalanceKey = (backstop: string, pool: string, user: string): xdr.LedgerKey =>
  xdr.LedgerKey.fromXdr(UserBalance.ledgerKey(backstop, pool, user).toXDR("base64"), "base64");
/** Everything below needs exactly one RPC method, so the real server and a stub both fit. */
type LedgerReader = LedgerEntriesReader;

/**
 * How many `getLedgerEntries` calls this process keeps in flight at once against one RPC
 * server. The sweep is a few thousand keys in chunks, and each round trip to a public RPC costs
 * a few hundred milliseconds regardless of size, so issuing them one after another made this
 * read take ~14 s on mainnet; issuing them together bounds the wall time by the deepest chain
 * of dependent reads instead. The budget is shared by every detection running against the same
 * server (account GET, close/plan and each close/transactions round all detect), not granted per
 * call: N concurrent analyses stay at this many in flight in total, rather than N times it, so
 * one burst cannot push the RPC's rate limit onto another user's request.
 */
export const LEDGER_READ_CONCURRENCY = 4;

/** A counting semaphore that hands out slots in request order. */
class ReadSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.active < this.limit) {
        this.active += 1;
        resolve();
      } else {
        this.waiting.push(() => {
          this.active += 1;
          resolve();
        });
      }
    });
  }

  release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

/** One slot pool per underlying reader (the memoized rpc.Server in production), so every
 *  detection in the process draws from the same budget. Weak so test doubles are collectable. */
const slotsByReader = new WeakMap<LedgerReader, ReadSlots>();
/** Readers this module already wrapped, so a limited reader handed back in is not limited twice
 *  (a second layer would only add a needless queue, never more parallelism). */
const limitedReaders = new WeakSet<LedgerReader>();

/**
 * A reader that draws on the shared slot pool of `rpc` and, once any of its own reads fails,
 * refuses the rest: a detection whose result is already lost to a rejection has no business
 * holding slots to keep hitting the RPC - least of all when the failure was a rate limit.
 */
function limitReads(rpc: LedgerReader, limit: number): LedgerReader {
  if (limitedReaders.has(rpc)) return rpc;
  let slots = slotsByReader.get(rpc);
  if (!slots) {
    slots = new ReadSlots(limit);
    slotsByReader.set(rpc, slots);
  }
  const pool = slots;
  let failure: unknown = null;
  const reader: LedgerReader = {
    getLedgerEntries: async (...keys) => {
      if (failure !== null) throw failure;
      await pool.acquire();
      try {
        if (failure !== null) throw failure;
        return await rpc.getLedgerEntries(...keys);
      } catch (err) {
        failure ??= err;
        throw err;
      } finally {
        pool.release();
      }
    },
  };
  limitedReaders.add(reader);
  return reader;
}

export interface DirectReadDeps {
  rpc?: RpcServer;
  /** Overridable for tests; defaults to the real registry's entries for the target network. */
  registryEntries?: ContractRegistryEntry[];
}

// ─── ScVal / ledger-key construction ─────────────────────────────────────────

/** Exported for tests, which independently re-derive expected ledger keys with these same
 *  primitives to confirm production key-building matches the documented ScVal shape. */
export function contractDataKey(contractAddress: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    })
  );
}

export const symbolVal = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
export const addressVal = (address: string): xdr.ScVal => new Address(address).toScVal();
export const variantVal = (variant: string, ...fields: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvVec([symbolVal(variant), ...fields]);

// ─── batched reads ────────────────────────────────────────────────────────────

/** Keyed by the ledger key's base64 XDR, since `getLedgerEntries` doesn't promise result order. */
async function batchRead(
  rpc: LedgerReader,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  if (keys.length === 0) return new Map();
  const res = await rpc.getLedgerEntries(...keys);
  const map = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) {
    map.set(entry.key.toXdr("base64"), entry.val);
  }
  return map;
}

function contractDataScVal(val: xdr.LedgerEntryData | undefined): unknown {
  if (!val) return undefined;
  return scValToNative(contractDataEntry(val).val);
}

/** A Rust `Map<K,V>` may decode to a JS `Map` or a plain object depending on key type -
 *  `scValToNative`'s own behavior isn't assumed here, both are handled. */
function mapEntries(native: unknown): Array<[string, unknown]> {
  if (native instanceof Map) return [...native.entries()].map(([k, v]) => [String(k), v]);
  if (native && typeof native === "object")
    return Object.entries(native as Record<string, unknown>);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** i128 amounts decode to `bigint` via scValToNative; anything else doesn't parse as an amount. */
function asBigInt(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

// ─── wasmHash verification ────────────────────────────────────────────────────

/**
 * Confirms a registry entry's contract still exists on-chain with the recorded wasmHash before
 * anything is decoded against it. Returns false (and pushes an `unrecognizedPositions` entry) on
 * either "contract not found" (a registry-integrity gap, not "this account has no position") or
 * a wasmHash mismatch (halt-on-unknown, same
 * invariant the exit adapters hold to).
 *
 * `live` is the code the ledger returned for the entry's instance - null when the contract does
 * not exist, is not Wasm-backed, or names code that cannot be resolved, the same reading
 * `readLiveCodeIdentity` gives - fetched for every entry in one batched read of the instances and
 * one of the external-reference tags, so verifying the registry costs two round trips at most
 * rather than one per contract.
 */
function verifyEntry(
  entry: ContractRegistryEntry,
  live: CodeIdentity | null,
  unrecognized: UnrecognizedDefiPosition[]
): boolean {
  if (live === null) {
    // The registry already records this entry as absent from the network (verifiedLive: false:
    // documented by the protocol but not deployed). Still absent is the registry's fact, not
    // this account's, and flagging it would block every account on the network - so it is
    // skipped only while the network agrees with the registry. The moment it resolves, the
    // branch below reports it, because a contract the registry has no hash for cannot be read.
    if (!entry.verifiedLive) return false;
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "registry-entry-unresolvable",
      reason: `registered ${entry.kind} contract ${entry.address} could not be resolved on ${entry.network}`,
    });
    return false;
  }
  if (entry.wasmHash === null) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "registry-entry-unpinned",
      reason: `registered ${entry.kind} contract ${entry.address} resolves on ${entry.network} (wasmHash ${live.wasmHash}) but the registry records no wasmHash to verify it against`,
    });
    return false;
  }
  const liveReference = live.kind === "wasm" ? "its own Wasm" : `${live.owner} tag ${live.tag}`;
  const pinnedReference =
    entry.executableOwner === undefined
      ? "its own Wasm"
      : `${entry.executableOwner} tag ${entry.executableTag}`;
  if (liveReference !== pinnedReference) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "executable-reference-mismatch",
      reason: `registered ${entry.kind} contract ${entry.address} takes its code from ${liveReference}, not the registry's recorded ${pinnedReference}`,
    });
    return false;
  }
  if (!codeMatchesEntry(entry, live)) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "wasmhash-mismatch",
      reason: `registered ${entry.kind} contract ${entry.address} is running wasmHash ${live.wasmHash}, not the registry's recorded ${entry.wasmHash}`,
    });
    return false;
  }
  return true;
}

// ─── Blend pool: supply/borrow ────────────────────────────────────────────────

async function readBlendPoolPositions(
  rpc: LedgerReader,
  entry: ContractRegistryEntry,
  address: string
): Promise<DefiPosition[]> {
  const resListKey = contractDataKey(entry.address, symbolVal("ResList"));
  const positionsKey = contractDataKey(entry.address, variantVal("Positions", addressVal(address)));
  const results = await batchRead(rpc, [resListKey, positionsKey]);

  const resListNative = contractDataScVal(results.get(resListKey.toXdr("base64")));
  const reserveList = Array.isArray(resListNative) ? (resListNative as string[]) : [];

  const positionsNative = contractDataScVal(results.get(positionsKey.toXdr("base64")));
  if (!isRecord(positionsNative)) return [];

  const assetFor = (index: string): string | null => reserveList[Number(index)] ?? null;
  const supplyTotals = new Map<string, bigint>();
  for (const [index, amount] of mapEntries(positionsNative.supply)) {
    const value = asBigInt(amount);
    if (value === null) continue;
    supplyTotals.set(index, (supplyTotals.get(index) ?? 0n) + value);
  }
  for (const [index, amount] of mapEntries(positionsNative.collateral)) {
    const value = asBigInt(amount);
    if (value === null) continue;
    supplyTotals.set(index, (supplyTotals.get(index) ?? 0n) + value);
  }

  const positions: DefiPosition[] = [];
  for (const [index, total] of supplyTotals) {
    const assetAddress = assetFor(index);
    if (!assetAddress || total === 0n) continue;
    const position: BlendSupplyPosition = {
      protocol: "blend",
      positionType: "supply",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      assetAddress,
      bTokenAmount: total.toString(),
      usdValue: null,
    };
    positions.push(position);
  }

  for (const [index, amount] of mapEntries(positionsNative.liabilities)) {
    const debt = asBigInt(amount);
    if (debt === null) continue;
    const assetAddress = assetFor(index);
    if (!assetAddress || debt === 0n) continue;
    const position: BlendBorrowPosition = {
      protocol: "blend",
      positionType: "borrow",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      assetAddress,
      dTokenAmount: debt.toString(),
      usdValue: null,
    };
    positions.push(position);
  }

  return positions;
}

// ─── Blend backstop: the account's deposit per pool ──────────────────────────

/**
 * Backstop deposits live in the backstop contract, keyed by (pool, user), not in the pool: one
 * read per registered pool of the same version. The deposit token is the backstop's own (the
 * BLND:USDC LP share), read from its instance. A deposit is reported whole - shares not queued
 * plus every queued withdrawal - because all of it is the account's to take out or wait for; the
 * exit adapter reads the queue itself to decide which.
 */
async function readBlendBackstopPositions(
  rpc: LedgerReader,
  backstop: ContractRegistryEntry,
  entries: ContractRegistryEntry[],
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const pools = entries.filter(
    (e) =>
      e.network === backstop.network &&
      e.protocol === "blend" &&
      e.kind === "pool" &&
      e.version === backstop.version &&
      e.verifiedLive
  );
  if (pools.length === 0) return [];
  const keys = pools.map((pool) => backstopBalanceKey(backstop.address, pool.address, address));
  const results = await batchRead(rpc, [instanceKey(backstop.address), ...keys]);
  const instance = results.get(instanceKey(backstop.address).toXdr("base64"));
  // The backstop keeps its config under bare symbols (`BToken` is the deposit token).
  const backstopToken = instance
    ? asAddress(parseInstance(instance).storage.get('"BToken"'))
    : null;

  const positions: DefiPosition[] = [];
  for (let i = 0; i < pools.length; i++) {
    const val = results.get(keys[i]!.toXdr("base64"));
    if (!val) continue;
    let balance: UserBalance;
    try {
      balance = UserBalance.fromLedgerEntryData(val.toXdr("base64"), Math.floor(Date.now() / 1000));
    } catch {
      unrecognized.push({
        protocol: "blend",
        rawType: "backstop-balance-unreadable",
        reason: `backstop ${backstop.address} holds an entry for this account and pool ${pools[i]!.address} that could not be decoded`,
      });
      continue;
    }
    const total = balance.shares + balance.totalQ4W;
    if (total <= 0n) continue;
    if (!backstopToken) {
      unrecognized.push({
        protocol: "blend",
        rawType: "backstop-token-unknown",
        reason: `backstop ${backstop.address} holds ${total} shares for this account in pool ${pools[i]!.address} but its deposit token could not be read`,
      });
      continue;
    }
    const position: BlendSupplyPosition = {
      protocol: "blend",
      positionType: "supply",
      contractAddress: pools[i]!.address,
      wasmHash: pools[i]!.wasmHash ?? undefined,
      assetAddress: backstopToken,
      bTokenAmount: total.toString(),
      usdValue: null,
      isBackstop: true,
    };
    positions.push(position);
  }
  return positions;
}

const entryVal = (entry: xdr.LedgerEntryData | undefined): xdr.ScVal | undefined =>
  entry ? contractDataEntry(entry).val : undefined;

// ─── Soroswap: every pair the factory deployed ───────────────────────────────

/** Stellar RPC caps getLedgerEntries at 200 keys per call; stay under it with room to spare. */
export const LEDGER_KEYS_PER_CALL = 150;

/** A factory or router past this size is not enumerated. The registered mainnet Soroswap
 *  factory (~215 pairs) and Aquarius router (~640 pools) are both swept under this cap. */
const MAX_FACTORY_PAIRS = 2_000;

/** Every chunk is issued at once; the reader's own concurrency limit paces them. */
async function batchReadChunked(
  rpc: LedgerReader,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const chunks: xdr.LedgerKey[][] = [];
  for (let i = 0; i < keys.length; i += LEDGER_KEYS_PER_CALL) {
    chunks.push(keys.slice(i, i + LEDGER_KEYS_PER_CALL));
  }
  const parts = await Promise.all(chunks.map((chunk) => batchRead(rpc, chunk)));
  const out = new Map<string, xdr.LedgerEntryData>();
  for (const part of parts) for (const [k, v] of part) out.set(k, v);
  return out;
}

interface ParsedInstance {
  /** The code the instance names, before an external reference is followed. */
  ref: CodeRef | null;
  /** Instance storage by its key's native JSON form, e.g. '["TotalPairs"]' or '0'. */
  storage: Map<string, xdr.ScVal>;
}

/** A contract instance entry as its code hash and storage. Pure: one entry in, no network. */
function parseInstance(val: xdr.LedgerEntryData): ParsedInstance {
  const instance = instanceOfEntry(val);
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage ?? []) {
    let name: unknown;
    try {
      name = JSON.stringify(scValToNative(entry.key));
    } catch {
      continue;
    }
    if (typeof name !== "string") continue;
    storage.set(name, entry.val);
  }
  return { ref: codeRefOf(instance), storage };
}

/** The live code behind each instance, following external references in one batched read. */
function resolveCodes(
  rpc: LedgerReader,
  refs: ReadonlyArray<CodeRef | null>
): Promise<Array<CodeIdentity | null>> {
  return resolveCodeRefs((keys) => batchReadChunked(rpc, keys), refs);
}

const instanceKey = (contractAddress: string): xdr.LedgerKey =>
  new Contract(contractAddress).getFootprint();

const asAddress = (val: xdr.ScVal | undefined): string | null => {
  if (!val || val.type !== "scvAddress") return null;
  return Address.fromScAddress(val.address).toString();
};

/**
 * Soroswap pairs are deployed by the factory and share one code hash, so the registry lists the
 * factory and one representative pair, and the pairs themselves are enumerated here: the factory
 * keeps `TotalPairs` in its instance and `PairAddressesNIndexed(i)` per pair (soroswap/core,
 * contracts/factory). Every pair's SEP-41 `Balance(user)` is read in one chunked sweep; the pairs
 * the account holds shares of are then read in one more chunked sweep, verified against the
 * registry's pair code (halt-on-unknown, same as any other contract), and their two tokens taken
 * from instance keys 0 and 1 (Token0, Token1). Every sweep is chunked and bounded by the pair
 * cap, so a stranger gifting one share of every pair to an account cannot inflate its analysis
 * beyond a fixed number of reads. On today's mainnet this is six ledger reads for ~215 pairs.
 */
async function readSoroswapFactoryPairs(
  rpc: LedgerReader,
  factory: ContractRegistryEntry,
  entries: ContractRegistryEntry[],
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const flag = (rawType: string, reason: string): void => {
    unrecognized.push({ protocol: "soroswap", rawType, reason });
  };

  const factoryKey = instanceKey(factory.address);
  const factoryVal = (await batchRead(rpc, [factoryKey])).get(factoryKey.toXdr("base64"));
  const total = factoryVal
    ? scValToNative(parseInstance(factoryVal).storage.get('["TotalPairs"]') ?? xdr.ScVal.scvVoid())
    : null;
  const count = typeof total === "number" ? total : null;
  if (count === null) {
    flag("factory-unreadable", `Soroswap factory ${factory.address} did not expose its pair count`);
    return [];
  }
  if (count > MAX_FACTORY_PAIRS) {
    flag(
      "factory-too-large",
      `Soroswap factory ${factory.address} lists ${count} pairs, above the ${MAX_FACTORY_PAIRS} this read enumerates`
    );
    return [];
  }

  const indexKeys = Array.from({ length: count }, (_, i) =>
    contractDataKey(factory.address, variantVal("PairAddressesNIndexed", xdr.ScVal.scvU32(i)))
  );
  const indexed = await batchReadChunked(rpc, indexKeys);
  const pairs = new Set<string>();
  for (const key of indexKeys) {
    const pair = asAddress(entryVal(indexed.get(key.toXdr("base64"))));
    if (pair) pairs.add(pair);
  }
  if (pairs.size !== count) {
    // An index the factory counts but the ledger does not return (archived, or a partial
    // response) could hide a pair the account holds; say so instead of pretending the sweep
    // was complete, and still report what did resolve.
    flag(
      "factory-index-gap",
      `Soroswap factory ${factory.address} lists ${count} pairs but only ${pairs.size} resolved to a distinct address`
    );
  }
  const pairList = [...pairs];

  const balanceKeys = pairList.map((pair) =>
    contractDataKey(pair, variantVal("Balance", addressVal(address)))
  );
  const balances = await batchReadChunked(rpc, balanceKeys);
  const held: Array<{ pair: string; shares: bigint }> = [];
  for (let i = 0; i < pairList.length; i++) {
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXdr("base64"))));
    if (shares === null || shares === 0n) continue;
    held.push({ pair: pairList[i]!, shares });
  }
  if (held.length === 0) return [];

  const heldKeys = held.map(({ pair }) => instanceKey(pair));
  const instances = await batchReadChunked(rpc, heldKeys);
  const pairEntries = entries.filter(
    (e) => e.network === factory.network && e.protocol === "soroswap" && e.kind === "pair"
  );
  const parsed = heldKeys.map((key) => {
    const val = instances.get(key.toXdr("base64"));
    return val ? parseInstance(val) : null;
  });
  const codes = await resolveCodes(
    rpc,
    parsed.map((p) => p?.ref ?? null)
  );

  const positions: DefiPosition[] = [];
  for (let i = 0; i < held.length; i++) {
    const { pair, shares } = held[i]!;
    const instance = parsed[i];
    if (!instance) {
      flag(
        "pair-code-unknown",
        `Soroswap pair ${pair} holds ${shares} shares for this account but has no contract instance on the ledger`
      );
      continue;
    }
    const code = codes[i] ?? null;
    if (code === null || !pairEntries.some((e) => codeMatchesEntry(e, code))) {
      flag(
        "pair-code-unknown",
        `Soroswap pair ${pair} holds ${shares} shares for this account but runs code the registry has not verified as a Soroswap pair`
      );
      continue;
    }
    const token0 = asAddress(instance.storage.get("0"));
    const token1 = asAddress(instance.storage.get("1"));
    const position: SoroswapLpPosition = {
      protocol: "soroswap",
      positionType: "lp",
      contractAddress: pair,
      wasmHash: code.wasmHash,
      shareAmount: shares.toString(),
      usdValue: null,
      ...(token0 && token1 ? { tokens: [token0, token1] as [string, string] } : {}),
    };
    positions.push(position);
  }
  return positions;
}

// ─── Aquarius: every pool the router knows ───────────────────────────────────

const AQUARIUS_POOL_TYPES: readonly AquariusPoolType[] = [
  "constant_product",
  "stable",
  "concentrated",
];

function aquariusPoolType(version: string): AquariusPoolType | null {
  return (AQUARIUS_POOL_TYPES as readonly string[]).includes(version)
    ? (version as AquariusPoolType)
    : null;
}

/** The router keys a token set's pools by sha256 over the tokens' ScVal XDR, concatenated. */
export function aquariusTokensHash(tokens: string[]): Buffer {
  return Buffer.from(hash(Buffer.concat(tokens.map((t) => new Address(t).toScVal().toXdr()))));
}

const asU128 = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isInteger(native)) return BigInt(native);
  return null;
};

/** Every address in an ScVec of addresses; null when the value is not exactly that. */
function asAddressList(val: xdr.ScVal | undefined): string[] | null {
  if (!val || val.type !== "scvVec") return null;
  const out: string[] = [];
  for (const item of val.vec ?? []) {
    const address = asAddress(item);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

/**
 * A `TokensSetPools` map value. The router stores each pool as a struct `{ address, pool_type }`
 * (its `get_pools` getter unwraps it to the address, which is why a simulated call shows a plain
 * map of addresses); a bare address is accepted too so an older router build still decodes.
 */
function aquariusPoolAddress(val: xdr.ScVal): string | null {
  if (val.type === "scvAddress") return asAddress(val);
  if (val.type !== "scvMap") return null;
  for (const entry of val.map ?? []) {
    const key = entry.key;
    if (key.type === "scvSymbol" && key.sym.toString() === "address") {
      return asAddress(entry.val);
    }
  }
  return null;
}

export interface AquariusPoolView {
  pool: string;
  /** The pool's live code; null when it cannot be resolved. */
  code: CodeIdentity | null;
  /** The pool's tokens in the pool's own order; null when the instance does not list them whole. */
  tokens: string[] | null;
  shareToken: string | null;
}

/**
 * Every pool the Aquarius router knows, with what its instance says about it. Exported so the
 * live integration test can assert the sweep enumerates real pools - a change in the router's
 * storage shape must fail loudly there, never read as "this account holds nothing".
 */
export async function enumerateAquariusPools(
  reader: LedgerReader,
  router: ContractRegistryEntry,
  flag: (rawType: string, reason: string) => void
): Promise<AquariusPoolView[] | null> {
  // Callers inside this module hand in a limited reader already; an outside caller (the live
  // integration test) gets the same concurrency bound rather than an unbounded fan-out.
  const rpc = limitReads(reader, LEDGER_READ_CONCURRENCY);
  const routerKey = instanceKey(router.address);
  const routerVal = (await batchRead(rpc, [routerKey])).get(routerKey.toXdr("base64"));
  const count = routerVal
    ? asU128(parseInstance(routerVal).storage.get('["TokensSetCounter"]'))
    : null;
  if (count === null) {
    flag(
      "router-unreadable",
      `Aquarius router ${router.address} did not expose its token-set count`
    );
    return null;
  }
  if (count > BigInt(MAX_FACTORY_PAIRS)) {
    flag(
      "router-too-large",
      `Aquarius router ${router.address} lists ${count} token sets, above the ${MAX_FACTORY_PAIRS} this read enumerates`
    );
    return null;
  }

  const setKeys = Array.from({ length: Number(count) }, (_, i) =>
    contractDataKey(
      router.address,
      variantVal("TokensSet", nativeToScVal(BigInt(i), { type: "u128" }))
    )
  );
  const sets = await batchReadChunked(rpc, setKeys);
  const tokenSets: string[][] = [];
  for (const key of setKeys) {
    const val = sets.get(key.toXdr("base64"));
    const tokens = val ? asAddressList(contractDataEntry(val).val) : null;
    if (tokens) tokenSets.push(tokens);
  }
  const poolKeys = tokenSets.map((tokens) =>
    contractDataKey(
      router.address,
      variantVal("TokensSetPools", xdr.ScVal.scvBytes(aquariusTokensHash(tokens)))
    )
  );
  const poolMaps = await batchReadChunked(rpc, poolKeys);
  const pools = new Set<string>();
  let poolMapsMissing = 0;
  let poolEntriesUnrecognized = 0;
  for (const key of poolKeys) {
    const val = poolMaps.get(key.toXdr("base64"));
    if (!val) {
      poolMapsMissing += 1;
      continue;
    }
    const map = contractDataEntry(val).val;
    if (map.type !== "scvMap") {
      poolEntriesUnrecognized += 1;
      continue;
    }
    for (const entry of map.map ?? []) {
      const pool = aquariusPoolAddress(entry.val);
      if (pool) pools.add(pool);
      else poolEntriesUnrecognized += 1;
    }
  }
  // Whatever the ledger did not return or this read could not decode may hide a pool the
  // account holds shares in; say so rather than narrowing the sweep in silence.
  if (tokenSets.length !== Number(count) || poolMapsMissing > 0 || poolEntriesUnrecognized > 0) {
    flag(
      "router-index-gap",
      `Aquarius router ${router.address}: ${count} token sets listed, ${tokenSets.length} resolved; ` +
        `${poolMapsMissing} pool maps missing; ${poolEntriesUnrecognized} pool entries not decodable`
    );
  }
  if (pools.size > MAX_FACTORY_PAIRS) {
    flag(
      "router-too-large",
      `Aquarius router ${router.address} lists ${pools.size} pools, above the ${MAX_FACTORY_PAIRS} this read enumerates`
    );
    return null;
  }

  const poolList = [...pools];
  const poolInstanceKeys = poolList.map((pool) => instanceKey(pool));
  const poolInstances = await batchReadChunked(rpc, poolInstanceKeys);
  const parsed = poolInstanceKeys.map((key) => {
    const val = poolInstances.get(key.toXdr("base64"));
    return val ? parseInstance(val) : null;
  });
  const codes = await resolveCodes(
    rpc,
    parsed.map((p) => p?.ref ?? null)
  );
  const views: AquariusPoolView[] = [];
  let poolInstancesMissing = 0;
  for (let i = 0; i < poolList.length; i++) {
    const instance = parsed[i];
    if (!instance) {
      poolInstancesMissing += 1;
      continue;
    }
    const tokens = instance.storage.has('["Tokens"]')
      ? asAddressList(instance.storage.get('["Tokens"]'))
      : (() => {
          const a = asAddress(instance.storage.get('["TokenA"]'));
          const b = asAddress(instance.storage.get('["TokenB"]'));
          return a && b ? [a, b] : null;
        })();
    views.push({
      pool: poolList[i]!,
      code: codes[i] ?? null,
      tokens,
      shareToken: asAddress(instance.storage.get('["TokenShare"]')),
    });
  }
  if (poolInstancesMissing > 0) {
    flag(
      "pool-unreadable",
      `Aquarius router ${router.address} lists ${poolInstancesMissing} pool${poolInstancesMissing === 1 ? "" : "s"} whose instance the ledger did not return`
    );
  }
  return views;
}

/**
 * Aquarius pools are deployed by the router and come in three codes (constant-product, stableswap,
 * concentrated); each pool's LP shares live in a separate share-token contract. The registry lists
 * the router and one representative pool per code, and the pools are enumerated here from the
 * router's storage (`TokensSetCounter`, `TokensSet(i)`, `TokensSetPools(hash)`; aquarius
 * liquidity_pool_router). Every share-based pool's share token is read for the account's SEP-41
 * `Balance(account)` in one chunked sweep, so a stranger gifting shares in many pools adds no
 * reads. A held pool is matched against the registry's pool codes; a code the registry has not
 * verified is flagged, never decoded. Concentrated pools keep positions as tick ranges without
 * shares and are skipped by this read (OctoPos reports them on mainnet).
 */
async function readAquariusRouterPools(
  rpc: LedgerReader,
  router: ContractRegistryEntry,
  entries: ContractRegistryEntry[],
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const flag = (rawType: string, reason: string): void => {
    unrecognized.push({ protocol: "aquarius", rawType, reason });
  };
  const knownCodes: Array<{ entry: ContractRegistryEntry; type: AquariusPoolType }> = [];
  for (const e of entries) {
    if (e.network !== router.network || e.protocol !== "aquarius" || e.kind !== "pool") continue;
    const type = aquariusPoolType(e.version);
    if (!type) {
      flag(
        "registry-version-unknown",
        `registry entry ${e.address} names Aquarius pool code version "${e.version}", which this read does not know`
      );
      continue;
    }
    knownCodes.push({ entry: e, type });
  }

  const views = await enumerateAquariusPools(rpc, router, flag);
  if (views === null) return [];

  const readable: Array<
    AquariusPoolView & { shareToken: string; type: AquariusPoolType | undefined }
  > = [];
  for (const view of views) {
    const code = view.code;
    const type = code
      ? knownCodes.find(({ entry }) => codeMatchesEntry(entry, code))?.type
      : undefined;
    if (type === "concentrated") continue;
    if (!view.shareToken) {
      // A share-based pool always names its share token. Without one, and without a verified
      // code, this may be a pool code the registry does not know yet - and the account may hold
      // a position there that cannot be read.
      if (!type) {
        flag(
          "pool-code-unknown",
          `Aquarius pool ${view.pool} runs code the registry has not verified and names no share token, so this account's position in it, if any, cannot be read`
        );
      }
      continue;
    }
    readable.push({ ...view, shareToken: view.shareToken, type });
  }

  const balanceKeys = readable.map((v) =>
    contractDataKey(v.shareToken, variantVal("Balance", addressVal(address)))
  );
  const balances = await batchReadChunked(rpc, balanceKeys);
  const positions: DefiPosition[] = [];
  for (let i = 0; i < readable.length; i++) {
    const view = readable[i]!;
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXdr("base64"))));
    if (shares === null || shares === 0n) continue;
    if (!view.type) {
      flag(
        "pool-code-unknown",
        `Aquarius pool ${view.pool} holds ${shares} shares for this account but runs code the registry has not verified as an Aquarius pool`
      );
      continue;
    }
    const position: AquariusLpPosition = {
      protocol: "aquarius",
      positionType: "lp",
      contractAddress: view.pool,
      wasmHash: view.code?.wasmHash,
      shareAmount: shares.toString(),
      usdValue: null,
      shareToken: view.shareToken,
      poolType: view.type,
      // Omitted rather than empty when the instance did not list every token: an exit would read
      // an empty list as "no minimums to set".
      ...(view.tokens ? { tokens: view.tokens } : {}),
    };
    positions.push(position);
  }
  return positions;
}

// ─── Phoenix LP shares and stakes ──────────────────────────────────────────────

/**
 * A Phoenix pool is not its own share token: its `CONFIG` names `share_token`, a separate SEP-41
 * contract, and `stake_contract`, where bonded shares live. Both of the account's entries are read
 * in one call: shares bonded in full leave a zero share balance, so the stake is the only trace of
 * the position. Each stake is reported on the pool with the share token, so the exit groups it
 * with the LP and its verifier knows the token the withdrawal returns.
 */
async function readPhoenixPosition(
  rpc: LedgerReader,
  entry: ContractRegistryEntry,
  address: string,
  verifiedStakes: ReadonlySet<string>,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const configKey = phoenixConfigKey(entry.address);
  const config = (await batchRead(rpc, [configKey])).get(configKey.toXdr("base64"));
  const shareToken = config ? phoenixShareToken(config) : null;
  if (!config || !shareToken) return [];
  const stakeContract = phoenixStakeContract(config);

  const balanceKey = contractDataKey(shareToken, variantVal("Balance", addressVal(address)));
  const bondingKey = stakeContract ? bondingInfoKey(stakeContract, address) : null;
  const results = await batchRead(rpc, bondingKey ? [balanceKey, bondingKey] : [balanceKey]);

  const positions: DefiPosition[] = [];
  const native = contractDataScVal(results.get(balanceKey.toXdr("base64")));
  const shareAmount = typeof native === "bigint" ? native : null;
  if (shareAmount !== null && shareAmount > 0n) {
    const lp: PhoenixLpPosition = {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      shareAmount: shareAmount.toString(),
      shareToken,
      usdValue: null,
    };
    positions.push(lp);
  }

  if (!stakeContract || !bondingKey) {
    unrecognized.push({
      protocol: "phoenix",
      rawType: "stake-contract-unknown",
      reason: `pool ${entry.address} names share token ${shareToken} but no stake contract, so its stakes cannot be read`,
    });
    return positions;
  }
  const bonding = results.get(bondingKey.toXdr("base64"));
  if (!bonding) return positions;
  if (!verifiedStakes.has(stakeContract)) {
    unrecognized.push({
      protocol: "phoenix",
      rawType: "stake-contract-unregistered",
      reason: `pool ${entry.address} names stake contract ${stakeContract}, which holds an entry for this account but is not a verified registry stake contract on ${entry.network}`,
    });
    return positions;
  }
  let stakes: ReturnType<typeof stakesFrom>;
  try {
    stakes = stakesFrom(contractDataEntry(bonding).val);
  } catch {
    stakes = null;
  }
  if (stakes === null) {
    unrecognized.push({
      protocol: "phoenix",
      rawType: "bonding-info-unreadable",
      reason: `stake contract ${stakeContract} holds an entry for this account that could not be decoded`,
    });
    return positions;
  }
  for (const stake of stakes) {
    if (stake.amount <= 0n) continue;
    const position: PhoenixStakePosition = {
      protocol: "phoenix",
      positionType: "stake",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      stakedAmount: stake.amount.toString(),
      stakedAtEpoch: stake.timestamp.toString(),
      shareToken,
      usdValue: null,
    };
    positions.push(position);
  }
  return positions;
}

// ─── FxDAO vault ───────────────────────────────────────────────────────────────

/**
 * The vault's own instance (already read once to verify its code) names the denominations it
 * keys vaults by and, per denomination, `Currency(denomination)`: the stablecoin a repay burns.
 */
async function readFxdaoVaults(
  rpc: LedgerReader,
  entry: ContractRegistryEntry,
  instance: xdr.LedgerEntryData,
  address: string
): Promise<DefiPosition[]> {
  const denominations = fxdaoDenominations(instance);
  const keys = denominations.map((denom) =>
    contractDataKey(
      entry.address,
      variantVal("Vault", xdr.ScVal.scvVec([addressVal(address), symbolVal(denom)]))
    )
  );
  const results = await batchRead(rpc, keys);

  const positions: DefiPosition[] = [];
  denominations.forEach((denomination, i) => {
    const native = contractDataScVal(results.get(keys[i]!.toXdr("base64")));
    if (!isRecord(native)) return;
    const collateral = native.total_collateral;
    const debt = native.total_debt;
    if (typeof collateral !== "bigint" || typeof debt !== "bigint") return;
    const debtToken = fxdaoCurrencyContract(instance, denomination);
    const position: FxdaoCdpPosition = {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      denomination,
      collateralAmount: collateral.toString(),
      debtAmount: debt.toString(),
      // Omitted when the vault does not name it: the verifier then refuses the repay, safely.
      ...(debtToken ? { debtToken } : {}),
      usdValue: null,
    };
    positions.push(position);
  });
  return positions;
}

// ─── entry point ────────────────────────────────────────────────────────────

/** What one registry entry's sweep contributes; concatenated in registry order by the caller. */
interface EntryOutcome {
  positions: DefiPosition[];
  unrecognized: UnrecognizedDefiPosition[];
}

async function readEntry(
  rpc: LedgerReader,
  entry: ContractRegistryEntry,
  instance: xdr.LedgerEntryData | undefined,
  liveCode: CodeIdentity | null,
  entries: ContractRegistryEntry[],
  address: string,
  verifiedStakes: ReadonlySet<string>
): Promise<EntryOutcome> {
  const positions: DefiPosition[] = [];
  const unrecognized: UnrecognizedDefiPosition[] = [];
  if (!verifyEntry(entry, liveCode, unrecognized) || !instance) {
    return { positions, unrecognized };
  }

  if (entry.protocol === "blend" && entry.kind === "backstop") {
    positions.push(
      ...(await readBlendBackstopPositions(rpc, entry, entries, address, unrecognized))
    );
  } else if (entry.kind === "backstop") {
    // Only Blend's backstop has a documented read.
  } else if (entry.protocol === "soroswap" && entry.kind === "factory") {
    positions.push(...(await readSoroswapFactoryPairs(rpc, entry, entries, address, unrecognized)));
  } else if (entry.protocol === "aquarius" && entry.kind === "router") {
    positions.push(...(await readAquariusRouterPools(rpc, entry, entries, address, unrecognized)));
  } else if (entry.protocol === "blend" && entry.kind === "pool") {
    positions.push(...(await readBlendPoolPositions(rpc, entry, address)));
  } else if (entry.protocol === "fxdao" && entry.kind === "vault") {
    positions.push(...(await readFxdaoVaults(rpc, entry, instance, address)));
  } else if (entry.protocol === "phoenix" && entry.kind === "pool") {
    positions.push(
      ...(await readPhoenixPosition(rpc, entry, address, verifiedStakes, unrecognized))
    );
  }
  return { positions, unrecognized };
}

/**
 * Which registry entries this read probes. Two reference contracts ARE probed, because they
 * enumerate the positions' contracts: the Soroswap factory (pairs) and the Aquarius router
 * (pools). Every other factory/router is skipped, and so are pair and Aquarius pool entries:
 * those stand for their code and are never read for balances themselves. An `executable-owner`
 * is probed only to verify its code: it decides what code every pool referencing it runs, so a
 * change to it halts the read like a router change does.
 */
function probedEntries(entries: ContractRegistryEntry[]): ContractRegistryEntry[] {
  return entries.filter((entry) => {
    const soroswapFactory = entry.protocol === "soroswap" && entry.kind === "factory";
    const aquariusRouter = entry.protocol === "aquarius" && entry.kind === "router";
    const aquariusPool = entry.protocol === "aquarius" && entry.kind === "pool";
    if (
      !soroswapFactory &&
      !aquariusRouter &&
      (entry.kind === "factory" || entry.kind === "router")
    )
      return false;
    if (entry.kind === "pair" || aquariusPool) return false;
    return true;
  });
}

export async function detectDefiPositionsViaDirectRead(
  address: string,
  network: Network = "testnet",
  deps: DirectReadDeps = {}
): Promise<DefiPositionsResult> {
  const rpc = limitReads(deps.rpc ?? getRpcServer(network), LEDGER_READ_CONCURRENCY);
  const entries = deps.registryEntries ?? entriesForNetwork(network);
  const probed = probedEntries(entries);

  // One read verifies every registered contract's live code, then every entry's sweep runs at
  // once. Outcomes are joined in registry order so the result does not depend on which RPC call
  // happened to return first.
  const instanceKeys = probed.map((entry) => instanceKey(entry.address));
  const instances = await batchReadChunked(rpc, instanceKeys);
  const instanceOf = (i: number): xdr.LedgerEntryData | undefined =>
    instances.get(instanceKeys[i]!.toXdr("base64"));
  const liveCodes = await resolveCodes(
    rpc,
    probed.map((_, i) => {
      const val = instanceOf(i);
      return val ? parseInstance(val).ref : null;
    })
  );
  const liveCodeOf = (i: number): CodeIdentity | null => liveCodes[i] ?? null;
  const verifiedStakes = new Set(
    probed
      .filter((entry, i) => {
        const code = liveCodeOf(i);
        return (
          entry.network === network &&
          entry.protocol === "phoenix" &&
          entry.kind === "stake" &&
          code !== null &&
          codeMatchesEntry(entry, code)
        );
      })
      .map((entry) => entry.address)
  );
  const outcomes = await Promise.all(
    probed.map((entry, i) =>
      readEntry(rpc, entry, instanceOf(i), liveCodeOf(i), entries, address, verifiedStakes)
    )
  );
  const positions = outcomes.flatMap((o) => o.positions);
  const unrecognized = outcomes.flatMap((o) => o.unrecognized);

  return {
    address,
    network,
    positions,
    unrecognizedPositions: unrecognized,
    enrichment: {},
    source: `${network}-direct-read`,
    timestamp: new Date().toISOString(),
    queryKeys: {
      rpcEndpoints: [],
      rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
      slices: {},
    },
  };
}
