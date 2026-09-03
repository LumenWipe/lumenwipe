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
 *  - Blend: pool supply/borrow only. Backstop shares are registered in the contract registry (for
 *    provenance) but not decoded here - `BackstopDataKey::UserBalance(PoolUserKey)`'s exact
 *    field-encoding order (a named-struct key, not a plain address or tuple) wasn't independently
 *    confirmed against primary source, and a wrong key here would silently read back as "no
 *    backstop position" rather than surface as unresolved - worse than not attempting it.
 *  - Aquarius/Soroswap/Phoenix: LP-share detection is wired against the standard SEP-41
 *    `Balance(Address)` layout every pool's share token follows (confirmed independently for two
 *    of the three), but the registry has no pool/pair instance for any of them yet - only
 *    routers/factories, kept as provenance references. It finds nothing until a real pool address
 *    lands via a reviewed registry pull request, the same way exchange-registry.json started small.
 *  - Phoenix has no public testnet deployment at all - no registry entry, nothing to check.
 *
 * ScVal key encoding: a soroban-sdk `#[contracttype]` enum's tuple variant with fields
 * `Variant(A)` encodes as `ScVec[Symbol("Variant"), A]`, and `Variant((A, B))` (a single field
 * whose type is itself the tuple `(A, B)`) encodes as `ScVec[Symbol("Variant"), ScVec[A, B]]` -
 * mechanically derived from each protocol's declared field shape, not assumed. Value decoding
 * uses `scValToNative`, which handles the Map/Vec distinction generically, so the key is the only
 * part this module has to construct by hand.
 */

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
      reason: `registered ${entry.kind} contract ${entry.address} could not be resolved on testnet`,
    });
    return false;
  }
  if (entry.wasmHash === null) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "registry-entry-unpinned",
      reason: `registered ${entry.kind} contract ${entry.address} resolves on testnet (wasmHash ${liveWasmHash}) but the registry records no wasmHash to verify it against`,
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

/**
 * Aquarius pools are deployed by the router and come in three codes (constant-product, stableswap,
 * concentrated); each pool's LP shares live in a separate share-token contract. The registry lists
 * the router and one representative pool per code, and the pools are enumerated here: the router
 * keeps `TokensSetCounter` in its instance, `TokensSet(i)` per token set, and `TokensSetPools(hash)`
 * mapping pool index to pool address (aquarius liquidity_pool_router). Every pool's instance names
 * its share token, and the account's shares are that token's SEP-41 `Balance(account)`. Held pools
 * are then matched against the registry's pool codes; a code the registry has not verified is
 * flagged, never decoded. Concentrated pools hold positions as tick ranges without shares and are
 * skipped by this read; OctoPos reports them on mainnet. Every sweep is chunked and bounded.
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
    return [];
  }
  if (count > BigInt(MAX_FACTORY_PAIRS)) {
    flag(
      "router-too-large",
      `Aquarius router ${router.address} lists ${count} token sets, above the ${MAX_FACTORY_PAIRS} this read enumerates`
    );
    return [];
  }

  // 1. Token sets, then each set's pools.
  const setKeys = Array.from({ length: Number(count) }, (_, i) =>
    contractDataKey(
      router.address,
      variantVal("TokensSet", nativeToScVal(BigInt(i), { type: "u128" }))
    )
  );
  const sets = await batchReadChunked(rpc, setKeys);
  const tokenSets: string[][] = [];
  for (const key of setKeys) {
    const native: unknown = contractDataScVal(sets.get(key.toXDR("base64")));
    if (Array.isArray(native) && native.every((t) => typeof t === "string")) {
      tokenSets.push(native as string[]);
    }
  }
  if (tokenSets.length !== Number(count)) {
    flag(
      "router-index-gap",
      `Aquarius router ${router.address} lists ${count} token sets but only ${tokenSets.length} resolved`
    );
  }
  const poolKeys = tokenSets.map((tokens) =>
    contractDataKey(
      router.address,
      variantVal("TokensSetPools", xdr.ScVal.scvBytes(aquariusTokensHash(tokens)))
    )
  );
  const poolMaps = await batchReadChunked(rpc, poolKeys);
  const pools = new Set<string>();
  for (const key of poolKeys) {
    for (const [, pool] of mapEntries(contractDataScVal(poolMaps.get(key.toXDR("base64"))))) {
      if (typeof pool === "string") pools.add(pool);
    }
  }
  const poolList = [...pools];

  // 2. Every pool's instance: code, tokens, share token.
  const poolInstanceKeys = poolList.map((pool) => instanceKey(pool));
  const poolInstances = await batchReadChunked(rpc, poolInstanceKeys);
  const knownCodes = new Map<string, AquariusPoolType>();
  for (const e of entries) {
    if (e.network !== router.network || e.protocol !== "aquarius" || e.kind !== "pool") continue;
    const type = aquariusPoolType(e.version);
    if (e.wasmHash && type) knownCodes.set(e.wasmHash, type);
  }
  interface PoolView {
    pool: string;
    wasmHash: string | null;
    tokens: string[];
    shareToken: string;
  }
  const views: PoolView[] = [];
  for (let i = 0; i < poolList.length; i++) {
    const val = poolInstances.get(poolInstanceKeys[i]!.toXDR("base64"));
    if (!val) continue;
    const instance = parseInstance(val);
    const type = instance.wasmHash ? knownCodes.get(instance.wasmHash) : undefined;
    // Concentrated pools keep positions as tick ranges and have no share token to read.
    if (type === "concentrated") continue;
    const shareToken = asAddress(instance.storage.get('["TokenShare"]'));
    if (!shareToken) continue;
    const listed: unknown = instance.storage.has('["Tokens"]')
      ? scValToNative(instance.storage.get('["Tokens"]')!)
      : [
          asAddress(instance.storage.get('["TokenA"]')),
          asAddress(instance.storage.get('["TokenB"]')),
        ];
    const tokens = Array.isArray(listed)
      ? listed.filter((t): t is string => typeof t === "string")
      : [];
    views.push({ pool: poolList[i]!, wasmHash: instance.wasmHash, tokens, shareToken });
  }

  // 3. The account's shares in every share token, one chunked sweep.
  const balanceKeys = views.map((v) =>
    contractDataKey(v.shareToken, variantVal("Balance", addressVal(address)))
  );
  const balances = await batchReadChunked(rpc, balanceKeys);
  const positions: DefiPosition[] = [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i]!;
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXDR("base64"))));
    if (shares === null || shares === 0n) continue;
    const type = view.wasmHash ? knownCodes.get(view.wasmHash) : undefined;
    if (!type) {
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
      tokens: view.tokens,
      shareToken: view.shareToken,
      poolType: type,
    };
    positions.push(position);
  }
  return positions;
}

// ─── standard SEP-41 LP share balance (Aquarius / Soroswap / Phoenix pools) ──

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

  if (entry.protocol === "aquarius") return { ...base, protocol: "aquarius", positionType: "lp" };
  if (entry.protocol === "soroswap") return { ...base, protocol: "soroswap", positionType: "lp" };
  if (entry.protocol === "phoenix") return { ...base, protocol: "phoenix", positionType: "lp" };
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
    if (entry.kind === "backstop" || entry.kind === "pair" || aquariusPool) continue;

    const verified = await verifyEntry(rpc, entry, unrecognized);
    if (!verified) continue;

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
