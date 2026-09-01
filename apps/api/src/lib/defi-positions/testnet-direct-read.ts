/**
 * The testnet DeFi-detection fallback (architecture.md §7.1, issue #148). OctoPos is mainnet
 * only - its own OpenAPI spec claims a testnet host, but that host doesn't resolve (see the note
 * on `OCTOPOS_API_URL_MAINNET` in config/networks.ts) - so testnet positions are read directly
 * over RPC `getLedgerEntries` against the contracts in the versioned contract registry
 * (lib/contract-registry), with the same "halt on unknown wasmHash, never decode against a shape
 * you haven't confirmed" discipline the exit adapters hold to (architecture.md §9.9), even though
 * this path builds nothing signable - it only reads.
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
import { entriesForNetwork, type ContractRegistryEntry } from "@/lib/contract-registry";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  DefiPositionsResult,
  FxdaoCdpPosition,
  UnrecognizedDefiPosition,
} from "@lumenwipe/types";

type RpcServer = ReturnType<typeof getRpcServer>;

export interface TestnetDirectReadDeps {
  rpc?: RpcServer;
  /** Overridable for tests; defaults to the real registry's testnet entries. */
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

async function resolveLiveWasmHash(
  rpc: RpcServer,
  contractAddress: string
): Promise<string | null> {
  const contract = new Contract(contractAddress);
  const res = await rpc.getLedgerEntries(contract.getFootprint());
  const entry = res.entries?.[0];
  if (!entry) return null;
  const instance = entry.val.contractData().val().instance();
  if (instance.executable().switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
    return null;
  }
  return instance.executable().wasmHash().toString("hex");
}

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
  const liveWasmHash = await resolveLiveWasmHash(rpc, entry.address);
  if (liveWasmHash === null) {
    unrecognized.push({
      protocol: entry.protocol,
      rawType: "registry-entry-unresolvable",
      reason: `registered ${entry.kind} contract ${entry.address} could not be resolved on testnet`,
    });
    return false;
  }
  if (entry.wasmHash !== null && liveWasmHash !== entry.wasmHash) {
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

export async function detectTestnetDefiPositions(
  address: string,
  deps: TestnetDirectReadDeps = {}
): Promise<DefiPositionsResult> {
  const rpc = deps.rpc ?? getRpcServer("testnet");
  const entries = deps.registryEntries ?? entriesForNetwork("testnet");

  const positions: DefiPosition[] = [];
  const unrecognized: UnrecognizedDefiPosition[] = [];

  for (const entry of entries) {
    if (entry.kind === "factory" || entry.kind === "router" || entry.kind === "backstop") continue;

    const verified = await verifyEntry(rpc, entry, unrecognized);
    if (!verified) continue;

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
    network: "testnet",
    positions,
    unrecognizedPositions: unrecognized,
    enrichment: {},
    source: "testnet-direct-read",
    timestamp: new Date().toISOString(),
    queryKeys: {
      rpcEndpoints: [],
      rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
      slices: {},
    },
  };
}
