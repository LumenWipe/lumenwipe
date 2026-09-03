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
 *  - Phoenix: LP shares are read from a registered pool's own SEP-41 `Balance(Address)`, but no
 *    pool instance is registered yet, so it finds nothing until one lands via a reviewed pull
 *    request.
 *  - Phoenix has no public testnet deployment at all - no registry entry, nothing to check.
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
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import { entriesForNetwork, type ContractRegistryEntry } from "@/lib/contract-registry";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  DefiPositionsResult,
  AquariusLpPosition,
  AquariusPoolType,
  FxdaoCdpPosition,
  Network,
  SoroswapLpPosition,
  UnrecognizedDefiPosition,
} from "@lumenwipe/types";

type RpcServer = ReturnType<typeof getRpcServer>;

export interface DirectReadDeps {
  rpc?: RpcServer;
  /** Overridable for tests; defaults to the real registry's entries for the target network. */
  registryEntries?: ContractRegistryEntry[];
}

const FXDAO_DENOMINATIONS = ["USDx", "EURx", "GBPx"] as const;

// ─── ScVal / ledger-key construction ─────────────────────────────────────────

/** Exported for tests, which independently re-derive expected ledger keys with these same
 *  primitives to confirm production key-building matches the documented ScVal shape. */
export function contractDataKey(contractAddress: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
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
  rpc: RpcServer,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  if (keys.length === 0) return new Map();
  const res = await rpc.getLedgerEntries(...keys);
  const map = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) {
    map.set(entry.key.toXDR("base64"), entry.val);
  }
  return map;
}

function contractDataScVal(val: xdr.LedgerEntryData | undefined): unknown {
  if (!val) return undefined;
  return scValToNative(val.contractData().val());
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
 * anything is decoded against it. Returns null (and pushes an `unrecognizedPositions` entry) on
 * either "contract not found" (a registry-integrity gap, not "this account has no position" -
 * exercised for real by the FxDAO entry today) or a wasmHash mismatch (halt-on-unknown, same
 * invariant the exit adapters hold to).
 */
async function verifyEntry(
  rpc: RpcServer,
  entry: ContractRegistryEntry,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<boolean> {
  const liveWasmHash = await readLiveWasmHash(rpc, entry.address);
  if (liveWasmHash === null) {
    // The registry already records this entry as absent from the network (verifiedLive: false,
    // FxDAO's documented-but-undeployed vault today). Still absent is the registry's fact, not
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
      reason: `registered ${entry.kind} contract ${entry.address} resolves on ${entry.network} (wasmHash ${liveWasmHash}) but the registry records no wasmHash to verify it against`,
    });
    return false;
  }
  if (liveWasmHash !== entry.wasmHash) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "wasmhash-mismatch",
      reason: `registered ${entry.kind} contract ${entry.address} is running wasmHash ${liveWasmHash}, not the registry's recorded ${entry.wasmHash}`,
    });
    return false;
  }
  return true;
}

// ─── Blend pool: supply/borrow ────────────────────────────────────────────────

async function readBlendPoolPositions(
  rpc: RpcServer,
  entry: ContractRegistryEntry,
  address: string
): Promise<DefiPosition[]> {
  const resListKey = contractDataKey(entry.address, symbolVal("ResList"));
  const positionsKey = contractDataKey(entry.address, variantVal("Positions", addressVal(address)));
  const results = await batchRead(rpc, [resListKey, positionsKey]);

  const resListNative = contractDataScVal(results.get(resListKey.toXDR("base64")));
  const reserveList = Array.isArray(resListNative) ? (resListNative as string[]) : [];

  const positionsNative = contractDataScVal(results.get(positionsKey.toXDR("base64")));
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
  rpc: RpcServer,
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
  const keys = pools.map((pool) => UserBalance.ledgerKey(backstop.address, pool.address, address));
  const results = await batchRead(rpc, [instanceKey(backstop.address), ...keys]);
  const instance = results.get(instanceKey(backstop.address).toXDR("base64"));
  // The backstop keeps its config under bare symbols (`BToken` is the deposit token).
  const backstopToken = instance
    ? asAddress(parseInstance(instance).storage.get('"BToken"'))
    : null;

  const positions: DefiPosition[] = [];
  for (let i = 0; i < pools.length; i++) {
    const val = results.get(keys[i]!.toXDR("base64"));
    if (!val) continue;
    let balance: UserBalance;
    try {
      balance = UserBalance.fromLedgerEntryData(val, Math.floor(Date.now() / 1000));
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

// ─── Soroswap: every pair the factory deployed ───────────────────────────────

/** Stellar RPC caps getLedgerEntries at 200 keys per call; stay well under it. */
const LEDGER_KEYS_PER_CALL = 100;

/** A factory past this size is not enumerated. No mainnet Soroswap factory is registered today;
 *  if one is added, the degraded-mode fallback sweeps it under this same cap. */
const MAX_FACTORY_PAIRS = 2_000;

async function batchReadChunked(
  rpc: RpcServer,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const out = new Map<string, xdr.LedgerEntryData>();
  for (let i = 0; i < keys.length; i += LEDGER_KEYS_PER_CALL) {
    const part = await batchRead(rpc, keys.slice(i, i + LEDGER_KEYS_PER_CALL));
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}

interface ParsedInstance {
  wasmHash: string | null;
  /** Instance storage by its key's native JSON form, e.g. '["TotalPairs"]' or '0'. */
  storage: Map<string, xdr.ScVal>;
}

/** A contract instance entry as its code hash and storage. Pure: one entry in, no network. */
function parseInstance(val: xdr.LedgerEntryData): ParsedInstance {
  const instance = val.contractData().val().instance();
  const executable = instance.executable();
  const wasmHash =
    executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
      ? executable.wasmHash().toString("hex")
      : null;
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage() ?? []) {
    let name: unknown;
    try {
      name = JSON.stringify(scValToNative(entry.key()));
    } catch {
      continue;
    }
    if (typeof name !== "string") continue;
    storage.set(name, entry.val());
  }
  return { wasmHash, storage };
}

const instanceKey = (contractAddress: string): xdr.LedgerKey =>
  new Contract(contractAddress).getFootprint();

const asAddress = (val: xdr.ScVal | undefined): string | null => {
  if (!val || val.switch() !== xdr.ScValType.scvAddress()) return null;
  return Address.fromScAddress(val.address()).toString();
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
 * beyond a fixed number of reads. On today's testnet this is nine ledger reads for ~225 pairs.
 */
async function readSoroswapFactoryPairs(
  rpc: RpcServer,
  factory: ContractRegistryEntry,
  entries: ContractRegistryEntry[],
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const flag = (rawType: string, reason: string): void => {
    unrecognized.push({ protocol: "soroswap", rawType, reason });
  };

  const factoryKey = instanceKey(factory.address);
  const factoryVal = (await batchRead(rpc, [factoryKey])).get(factoryKey.toXDR("base64"));
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
    const pair = asAddress(indexed.get(key.toXDR("base64"))?.contractData().val());
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
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXDR("base64"))));
    if (shares === null || shares === 0n) continue;
    held.push({ pair: pairList[i]!, shares });
  }
  if (held.length === 0) return [];

  const heldKeys = held.map(({ pair }) => instanceKey(pair));
  const instances = await batchReadChunked(rpc, heldKeys);
  const knownPairHashes = new Set(
    entries
      .filter(
        (e) => e.network === factory.network && e.protocol === "soroswap" && e.kind === "pair"
      )
      .map((e) => e.wasmHash)
  );

  const positions: DefiPosition[] = [];
  for (let i = 0; i < held.length; i++) {
    const { pair, shares } = held[i]!;
    const val = instances.get(heldKeys[i]!.toXDR("base64"));
    if (!val) {
      flag(
        "pair-code-unknown",
        `Soroswap pair ${pair} holds ${shares} shares for this account but has no contract instance on the ledger`
      );
      continue;
    }
    const instance = parseInstance(val);
    if (instance.wasmHash === null || !knownPairHashes.has(instance.wasmHash)) {
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
      wasmHash: instance.wasmHash,
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
  return hash(Buffer.concat(tokens.map((t) => new Address(t).toScVal().toXDR())));
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
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: string[] = [];
  for (const item of val.vec() ?? []) {
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
  if (val.switch() === xdr.ScValType.scvAddress()) return asAddress(val);
  if (val.switch() !== xdr.ScValType.scvMap()) return null;
  for (const entry of val.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol() && key.sym().toString() === "address") {
      return asAddress(entry.val());
    }
  }
  return null;
}

export interface AquariusPoolView {
  pool: string;
  wasmHash: string | null;
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
  rpc: RpcServer,
  router: ContractRegistryEntry,
  flag: (rawType: string, reason: string) => void
): Promise<AquariusPoolView[] | null> {
  const routerKey = instanceKey(router.address);
  const routerVal = (await batchRead(rpc, [routerKey])).get(routerKey.toXDR("base64"));
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
    const val = sets.get(key.toXDR("base64"));
    const tokens = val ? asAddressList(val.contractData().val()) : null;
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
    const val = poolMaps.get(key.toXDR("base64"));
    if (!val) {
      poolMapsMissing += 1;
      continue;
    }
    const map = val.contractData().val();
    if (map.switch() !== xdr.ScValType.scvMap()) {
      poolEntriesUnrecognized += 1;
      continue;
    }
    for (const entry of map.map() ?? []) {
      const pool = aquariusPoolAddress(entry.val());
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
  const views: AquariusPoolView[] = [];
  let poolInstancesMissing = 0;
  for (let i = 0; i < poolList.length; i++) {
    const val = poolInstances.get(poolInstanceKeys[i]!.toXDR("base64"));
    if (!val) {
      poolInstancesMissing += 1;
      continue;
    }
    const instance = parseInstance(val);
    const tokens = instance.storage.has('["Tokens"]')
      ? asAddressList(instance.storage.get('["Tokens"]'))
      : (() => {
          const a = asAddress(instance.storage.get('["TokenA"]'));
          const b = asAddress(instance.storage.get('["TokenB"]'));
          return a && b ? [a, b] : null;
        })();
    views.push({
      pool: poolList[i]!,
      wasmHash: instance.wasmHash,
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
  rpc: RpcServer,
  router: ContractRegistryEntry,
  entries: ContractRegistryEntry[],
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const flag = (rawType: string, reason: string): void => {
    unrecognized.push({ protocol: "aquarius", rawType, reason });
  };
  const knownCodes = new Map<string, AquariusPoolType>();
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
    if (e.wasmHash) knownCodes.set(e.wasmHash, type);
  }

  const views = await enumerateAquariusPools(rpc, router, flag);
  if (views === null) return [];

  const readable: Array<
    AquariusPoolView & { shareToken: string; type: AquariusPoolType | undefined }
  > = [];
  for (const view of views) {
    const type = view.wasmHash ? knownCodes.get(view.wasmHash) : undefined;
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
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXDR("base64"))));
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
      wasmHash: view.wasmHash ?? undefined,
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

// ─── standard SEP-41 LP share balance (Phoenix pools; Soroswap and Aquarius enumerate) ──

async function readLpShareBalance(
  rpc: RpcServer,
  entry: ContractRegistryEntry,
  address: string
): Promise<DefiPosition | null> {
  const balanceKey = contractDataKey(entry.address, variantVal("Balance", addressVal(address)));
  const results = await batchRead(rpc, [balanceKey]);
  const native = contractDataScVal(results.get(balanceKey.toXDR("base64")));
  const shareAmount = typeof native === "bigint" ? native : null;
  if (shareAmount === null || shareAmount === 0n) return null;

  const base = {
    contractAddress: entry.address,
    wasmHash: entry.wasmHash ?? undefined,
    shareAmount: shareAmount.toString(),
    usdValue: null,
  };

  if (entry.protocol === "phoenix") return { ...base, protocol: "phoenix", positionType: "lp" };
  // Soroswap pairs and Aquarius pools never reach this read: they are enumerated from their
  // factory and router above, and their share balances live where those sweeps look.
  return null;
}

// ─── FxDAO vault ───────────────────────────────────────────────────────────────

async function readFxdaoVaults(
  rpc: RpcServer,
  entry: ContractRegistryEntry,
  address: string
): Promise<DefiPosition[]> {
  const keys = FXDAO_DENOMINATIONS.map((denom) =>
    contractDataKey(
      entry.address,
      variantVal("Vault", xdr.ScVal.scvVec([addressVal(address), symbolVal(denom)]))
    )
  );
  const results = await batchRead(rpc, keys);

  const positions: DefiPosition[] = [];
  for (let i = 0; i < FXDAO_DENOMINATIONS.length; i++) {
    const native = contractDataScVal(results.get(keys[i]!.toXDR("base64")));
    if (!isRecord(native)) continue;
    const collateral = native.total_collateral;
    const debt = native.total_debt;
    if (typeof collateral !== "bigint" || typeof debt !== "bigint") continue;
    const position: FxdaoCdpPosition = {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: entry.address,
      wasmHash: entry.wasmHash ?? undefined,
      denomination: FXDAO_DENOMINATIONS[i]!,
      collateralAmount: collateral.toString(),
      debtAmount: debt.toString(),
      usdValue: null,
    };
    positions.push(position);
  }
  return positions;
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function detectDefiPositionsViaDirectRead(
  address: string,
  network: Network = "testnet",
  deps: DirectReadDeps = {}
): Promise<DefiPositionsResult> {
  const rpc = deps.rpc ?? getRpcServer(network);
  const entries = deps.registryEntries ?? entriesForNetwork(network);

  const positions: DefiPosition[] = [];
  const unrecognized: UnrecognizedDefiPosition[] = [];

  for (const entry of entries) {
    // Two reference contracts ARE probed, because they enumerate the positions' contracts: the
    // Soroswap factory (pairs) and the Aquarius router (pools). Aquarius pool entries stand for
    // their code and are never read for balances themselves.
    const soroswapFactory = entry.protocol === "soroswap" && entry.kind === "factory";
    const aquariusRouter = entry.protocol === "aquarius" && entry.kind === "router";
    const aquariusPool = entry.protocol === "aquarius" && entry.kind === "pool";
    if (
      !soroswapFactory &&
      !aquariusRouter &&
      (entry.kind === "factory" || entry.kind === "router")
    )
      continue;
    if (entry.kind === "pair" || aquariusPool) continue;

    const verified = await verifyEntry(rpc, entry, unrecognized);
    if (!verified) continue;

    if (entry.protocol === "blend" && entry.kind === "backstop") {
      positions.push(
        ...(await readBlendBackstopPositions(rpc, entry, entries, address, unrecognized))
      );
      continue;
    }
    if (entry.kind === "backstop") continue;

    if (soroswapFactory) {
      positions.push(
        ...(await readSoroswapFactoryPairs(rpc, entry, entries, address, unrecognized))
      );
      continue;
    }
    if (aquariusRouter) {
      positions.push(
        ...(await readAquariusRouterPools(rpc, entry, entries, address, unrecognized))
      );
      continue;
    }

    if (entry.protocol === "blend" && entry.kind === "pool") {
      positions.push(...(await readBlendPoolPositions(rpc, entry, address)));
    } else if (entry.protocol === "fxdao" && entry.kind === "vault") {
      positions.push(...(await readFxdaoVaults(rpc, entry, address)));
    } else if (entry.kind === "pool") {
      const lp = await readLpShareBalance(rpc, entry, address);
      if (lp) positions.push(lp);
    }
  }

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
