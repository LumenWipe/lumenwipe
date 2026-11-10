import registryJson from "@/config/exchange-registry.json";
import type { Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";

/**
 * The one registry artifact in the repo, in apps/api, where the API build and the deploy image already reach it.
 *
 * It used to exist twice, byte-identical, in apps/api and apps/web, each with its own identical
 * lookup module - so a memo rule could be corrected in one and not the other, and nothing would
 * say so. The API serves it; the web consumes what is served and keeps this same file only as a
 * floor for when the endpoint is unreachable.
 */

export interface RegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash";
  /** Present only on an entry scoped to testnet. Absent means the entry applies on every network. */
  network?: "testnet";
}

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid exchange registry: ${message}`);
    this.name = "RegistryValidationError";
  }
}

const MEMO_TYPES: readonly string[] = ["text", "id", "hash"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistryValidationError(`${where} needs a non-empty "${key}"`);
  }
  return value;
}

function requireDate(source: Record<string, unknown>, key: string): string {
  const value = requireText(source, key, "the registry");
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RegistryValidationError(`"${key}" must be a YYYY-MM-DD date, got "${value}"`);
  }
  return value;
}

function parseEntry(raw: unknown, index: number): RegistryEntry {
  if (!isRecord(raw)) throw new RegistryValidationError(`entry ${index} is not an object`);
  const where = `entry ${index}`;
  const address = requireText(raw, "address", where);
  if (!isValidGAddress(address)) {
    throw new RegistryValidationError(`${where} has an invalid account address "${address}"`);
  }
  const name = requireText(raw, "name", `${where} (${address})`);
  const domain = requireText(raw, "domain", `${where} (${address})`);
  const { requiresMediator, requiresMemo, memoType } = raw;
  if (typeof requiresMediator !== "boolean" || typeof requiresMemo !== "boolean") {
    throw new RegistryValidationError(
      `${where} (${name}) needs boolean "requiresMediator" and "requiresMemo"`
    );
  }
  if (memoType === undefined && requiresMemo) {
    throw new RegistryValidationError(`${where} (${name}) requires a memo but has no memoType`);
  }
  if (typeof memoType !== "string" || !MEMO_TYPES.includes(memoType)) {
    throw new RegistryValidationError(
      `${where} (${name}) has unknown memoType "${String(memoType)}"`
    );
  }
  if ("network" in raw && raw.network !== "testnet") {
    throw new RegistryValidationError(
      `${where} (${name}) has unknown network ${JSON.stringify(raw.network)}: only "testnet" may be set`
    );
  }
  return {
    address,
    name,
    domain,
    requiresMediator,
    requiresMemo,
    memoType: memoType as RegistryEntry["memoType"],
    ...(raw.network === "testnet" ? { network: "testnet" as const } : {}),
  };
}

interface LoadedRegistry {
  version: string;
  lastVerified: string;
  validUntil: string;
  source: string;
  entries: RegistryEntry[];
}

export function parseRegistry(raw: unknown): LoadedRegistry {
  if (!isRecord(raw)) throw new RegistryValidationError("the file is not an object");
  if (!Array.isArray(raw.entries)) throw new RegistryValidationError(`"entries" must be an array`);
  const entries = raw.entries.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.address)) {
      throw new RegistryValidationError(`duplicate address ${entry.address} (${entry.name})`);
    }
    seen.add(entry.address);
  }
  return {
    version: requireText(raw, "version", "the registry"),
    lastVerified: requireDate(raw, "lastVerified"),
    validUntil: requireDate(raw, "validUntil"),
    source: requireText(raw, "source", "the registry"),
    entries,
  };
}

export interface RegistryLookups {
  lookup(address: string, network: Network): RegistryEntry | null;
  requiresMediator(address: string, network: Network): boolean;
}

export function registryLookups(entries: readonly RegistryEntry[]): RegistryLookups {
  const indexFor = (network: Network): ReadonlyMap<string, RegistryEntry> =>
    new Map(
      entries
        .filter((e) => e.network === undefined || e.network === network)
        .map((e) => [e.address, e])
    );
  const byNetwork: Readonly<Record<Network, ReadonlyMap<string, RegistryEntry>>> = {
    mainnet: indexFor("mainnet"),
    testnet: indexFor("testnet"),
  };
  const lookup = (address: string, network: Network): RegistryEntry | null =>
    byNetwork[network].get(address) ?? null;
  return {
    lookup,
    requiresMediator: (address, network) => lookup(address, network)?.requiresMediator ?? false,
  };
}

const registry = parseRegistry(registryJson);
const shipped = registryLookups(registry.entries);

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

export function servedRegistry(from: LoadedRegistry = registry): ServedRegistry {
  return {
    version: from.version,
    lastVerified: from.lastVerified,
    validUntil: from.validUntil,
    source: from.source,
    entries: from.entries,
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

export const REGISTRY_WARN_DAYS = 30;

/** Whole days left before the registry stops being trusted; negative once it has expired. */
export function registryDaysRemaining(now: Date = new Date()): number {
  const validUntil = Date.parse(`${registry.validUntil}T23:59:59Z`);
  return Math.floor((validUntil - now.getTime()) / 86_400_000);
}

export function registryExpiryWarning(now: Date = new Date()): string | null {
  if (!isRegistryFresh(now)) {
    return `The exchange registry expired on ${registry.validUntil}: exchange closes are refused until it is re-verified and restamped (CONTRIBUTING section 9).`;
  }
  const days = registryDaysRemaining(now);
  if (days >= REGISTRY_WARN_DAYS) return null;
  return `The exchange registry expires on ${registry.validUntil} (${days} days left): re-verify every entry against the exchange's own deposit docs and restamp lastVerified/validUntil (CONTRIBUTING section 9).`;
}

export function lookupExchange(address: string, network: Network): RegistryEntry | null {
  return shipped.lookup(address, network);
}

/** Listed on any network. Only for redacting logs, which never decide how a close is built. */
export function isCexAddress(address: string): boolean {
  return shipped.lookup(address, "mainnet") !== null || shipped.lookup(address, "testnet") !== null;
}

export function requiresMediatorForAddress(address: string, network: Network): boolean {
  return shipped.requiresMediator(address, network);
}

export function getMemoRequirement(
  address: string,
  network: Network
): {
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
} {
  const entry = shipped.lookup(address, network);
  if (!entry) return { requiresMemo: false, memoType: null, exchangeName: null };
  return {
    requiresMemo: entry.requiresMemo,
    memoType: entry.requiresMemo ? entry.memoType : null,
    exchangeName: entry.name,
  };
}
