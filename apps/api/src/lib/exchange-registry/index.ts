import registry from "@config/exchange-registry.json";

/**
 * The one registry artifact in the repo, at the workspace root rather than inside either app.
 *
 * It used to exist twice, byte-identical, in apps/api and apps/web, each with its own identical
 * lookup module - so a memo rule could be corrected in one and not the other, and nothing would
 * say so. The API serves it; the web consumes what is served and keeps this same file only as a
 * floor for when the endpoint is unreachable.
 */

interface RegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash";
}

const entries = registry.entries as RegistryEntry[];
const byAddress = new Map(entries.map((e) => [e.address, e]));

/** The registry as served: the entries plus the freshness a consumer can judge them by. */
export interface ServedRegistry {
  version: string;
  /** The date a human last checked every entry against the exchanges' own deposit docs. */
  lastVerified: string;
  /** After this date the data is treated as unusable, not merely old. */
  validUntil: string;
  source: string;
  entries: RegistryEntry[];
}

export function servedRegistry(): ServedRegistry {
  return {
    version: registry.version,
    lastVerified: registry.lastVerified,
    validUntil: registry.validUntil,
    source: registry.source,
    entries,
  };
}

/**
 * Whether the registry is still within its verification window.
 *
 * Compared as dates, not "days since": the file states when it stops being trustworthy, so the
 * rule lives in the data rather than in whichever consumer happens to evaluate it.
 */
export function isRegistryFresh(now: Date = new Date()): boolean {
  const validUntil = Date.parse(`${registry.validUntil}T23:59:59Z`);
  return Number.isFinite(validUntil) && now.getTime() <= validUntil;
}

export function lookupExchange(address: string): RegistryEntry | null {
  return byAddress.get(address) ?? null;
}

export function isCexAddress(address: string): boolean {
  return byAddress.has(address);
}

export function requiresMediatorForAddress(address: string): boolean {
  return byAddress.get(address)?.requiresMediator ?? false;
}

export function getMemoRequirement(address: string): {
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
} {
  const entry = byAddress.get(address);
  if (!entry) return { requiresMemo: false, memoType: null, exchangeName: null };
  return {
    requiresMemo: entry.requiresMemo,
    memoType: entry.requiresMemo ? entry.memoType : null,
    exchangeName: entry.name,
  };
}
