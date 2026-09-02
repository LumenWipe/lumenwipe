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

import { Address, Contract, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import {
  entriesForNetwork,
  resolveWasmHash,
  type ContractRegistryEntry,
} from "@/lib/contract-registry";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  DefiPositionsResult,
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

/** A factory past this size is not enumerated: a testnet reset would leave far fewer, and mainnet
 *  detection does not run through this path at all (OctoPos reports pairs by address). */
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

/** The instance storage of a contract as (native key -> ScVal) pairs, with its code hash. */
async function readInstance(
  rpc: RpcServer,
  contractAddress: string
): Promise<{ wasmHash: string | null; storage: Map<string, xdr.ScVal> } | null> {
  const key = new Contract(contractAddress).getFootprint();
  const results = await batchRead(rpc, [key]);
  const val = results.get(key.toXDR("base64"));
  if (!val) return null;
  const instance = val.contractData().val().instance();
  const executable = instance.executable();
  const wasmHash =
    executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
      ? executable.wasmHash().toString("hex")
      : null;
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage() ?? []) {
    let name: string;
    try {
      name = JSON.stringify(scValToNative(entry.key()));
    } catch {
      continue;
    }
    storage.set(name, entry.val());
  }
  return { wasmHash, storage };
}

const asAddress = (val: xdr.ScVal | undefined): string | null => {
  if (!val || val.switch() !== xdr.ScValType.scvAddress()) return null;
  return Address.fromScAddress(val.address()).toString();
};

/**
 * Soroswap pairs are deployed by the factory and share one code hash, so the registry lists the
 * factory and one representative pair, and the pairs themselves are enumerated here: the factory
 * keeps `TotalPairs` in its instance and `PairAddressesNIndexed(i)` per pair (soroswap/core,
 * contracts/factory). Every pair's SEP-41 `Balance(user)` is read in one chunked sweep; a pair the
 * account holds shares of is then verified against the registry's pair code (halt-on-unknown,
 * same as any other contract) and its two tokens read from instance keys 0 and 1 (Token0,
 * Token1). On today's testnet that is one instance read, three chunked reads for ~225 pairs, and
 * one read per pair held.
 */
async function readSoroswapFactoryPairs(
  rpc: RpcServer,
  factory: ContractRegistryEntry,
  address: string,
  unrecognized: UnrecognizedDefiPosition[]
): Promise<DefiPosition[]> {
  const instance = await readInstance(rpc, factory.address);
  const total = instance
    ? scValToNative(instance.storage.get('["TotalPairs"]') ?? xdr.ScVal.scvVoid())
    : null;
  const count = typeof total === "number" ? total : null;
  if (count === null) {
    unrecognized.push({
      protocol: "soroswap",
      rawType: "factory-unreadable",
      reason: `Soroswap factory ${factory.address} did not expose its pair count`,
    });
    return [];
  }
  if (count > MAX_FACTORY_PAIRS) {
    unrecognized.push({
      protocol: "soroswap",
      rawType: "factory-too-large",
      reason: `Soroswap factory ${factory.address} lists ${count} pairs, above the ${MAX_FACTORY_PAIRS} this read enumerates`,
    });
    return [];
  }

  const indexKeys = Array.from({ length: count }, (_, i) =>
    contractDataKey(factory.address, variantVal("PairAddressesNIndexed", xdr.ScVal.scvU32(i)))
  );
  const indexed = await batchReadChunked(rpc, indexKeys);
  const pairs: string[] = [];
  for (const key of indexKeys) {
    const pair = asAddress(indexed.get(key.toXDR("base64"))?.contractData().val());
    if (pair) pairs.push(pair);
  }

  const balanceKeys = pairs.map((pair) =>
    contractDataKey(pair, variantVal("Balance", addressVal(address)))
  );
  const balances = await batchReadChunked(rpc, balanceKeys);

  const positions: DefiPosition[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const shares = asBigInt(contractDataScVal(balances.get(balanceKeys[i]!.toXDR("base64"))));
    if (shares === null || shares === 0n) continue;

    const pairInstance = await readInstance(rpc, pair);
    const resolution =
      pairInstance?.wasmHash !== null && pairInstance?.wasmHash !== undefined
        ? resolveWasmHash(factory.network, pairInstance.wasmHash)
        : null;
    if (
      !pairInstance ||
      resolution === null ||
      resolution.status !== "known" ||
      resolution.protocol !== "soroswap" ||
      resolution.kind !== "pair"
    ) {
      unrecognized.push({
        protocol: "soroswap",
        rawType: "pair-code-unknown",
        reason: `Soroswap pair ${pair} holds ${shares} shares for this account but runs code the registry has not verified as a Soroswap pair`,
      });
      continue;
    }
    const token0 = asAddress(pairInstance.storage.get("0"));
    const token1 = asAddress(pairInstance.storage.get("1"));
    const position: SoroswapLpPosition = {
      protocol: "soroswap",
      positionType: "lp",
      contractAddress: pair,
      wasmHash: pairInstance.wasmHash ?? undefined,
      shareAmount: shares.toString(),
      usdValue: null,
      ...(token0 && token1 ? { tokens: [token0, token1] as [string, string] } : {}),
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
    // A Soroswap factory is the one reference contract that IS probed: it enumerates the pairs.
    const soroswapFactory = entry.protocol === "soroswap" && entry.kind === "factory";
    if (!soroswapFactory && (entry.kind === "factory" || entry.kind === "router")) continue;
    if (entry.kind === "backstop" || entry.kind === "pair") continue;

    const verified = await verifyEntry(rpc, entry, unrecognized);
    if (!verified) continue;

    if (soroswapFactory) {
      positions.push(...(await readSoroswapFactoryPairs(rpc, entry, address, unrecognized)));
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
