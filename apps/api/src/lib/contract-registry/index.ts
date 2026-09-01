import registry from "@/config/contract-registry.json";
import type { DefiProtocol, Network } from "@lumenwipe/types";

/**
 * The versioned wasmHash -> protocol registry architecture.md §9 describes, scoped to what the
 * testnet DeFi-detection fallback (#148) needs: which contracts to probe for a position, and
 * the wasmHash to confirm each one is still running the code this registry was verified against.
 *
 * Deliberately not the general-purpose exit-adapter registry tracked in #152 ("registry and its
 * lookup interface only," part of the separate protocol-exit-adapters epic #151) - that issue's
 * own body says to coordinate on shape rather than build two, so this stays scoped to detection
 * fields only (no exit-adapter metadata) for #152 to extend, not replace.
 *
 * Not served over HTTP, unlike the exchange registry: the web holds no transaction-building or
 * position-detection logic (CLAUDE.md's trust boundary), so nothing client-side ever needs a
 * wasmHash. This stays an internal API module.
 */

export type ContractKind = "pool" | "backstop" | "vault" | "factory" | "router";

export interface ContractRegistryEntry {
  network: Network;
  protocol: DefiProtocol;
  kind: ContractKind;
  address: string;
  /** Null only for an entry documented by the protocol's own docs but not currently resolvable
   *  on-chain (see the fxdao/vault entry) - never fabricated to fill the field. */
  wasmHash: string | null;
  version: string;
  label: string;
  /** Whether `stellar contract fetch` resolved this address at the time `lastVerified` was set. */
  verifiedLive: boolean;
}

interface ServedContractRegistry {
  version: string;
  lastVerified: string;
  validUntil: string;
  source: string;
  entries: ContractRegistryEntry[];
}

const entries = registry.entries as ContractRegistryEntry[];
const byWasmHash = new Map(
  entries
    .filter((e): e is ContractRegistryEntry & { wasmHash: string } => e.wasmHash !== null)
    .map((e) => [e.wasmHash, e])
);

export function servedContractRegistry(): ServedContractRegistry {
  return {
    version: registry.version,
    lastVerified: registry.lastVerified,
    validUntil: registry.validUntil,
    source: registry.source,
    entries,
  };
}

/** Same fail-closed convention as `isRegistryFresh` in lib/exchange-registry: compared as dates,
 *  not "days since," so the rule lives in the data rather than in whichever consumer evaluates it. */
export function isRegistryFresh(now: Date = new Date()): boolean {
  const validUntil = Date.parse(`${registry.validUntil}T23:59:59Z`);
  return Number.isFinite(validUntil) && now.getTime() <= validUntil;
}

export function entriesForNetwork(network: Network): ContractRegistryEntry[] {
  return entries.filter((e) => e.network === network);
}

export function entriesForProtocol(
  network: Network,
  protocol: DefiProtocol
): ContractRegistryEntry[] {
  return entries.filter((e) => e.network === network && e.protocol === protocol);
}

export function lookupByWasmHash(wasmHash: string): ContractRegistryEntry | null {
  return byWasmHash.get(wasmHash) ?? null;
}
