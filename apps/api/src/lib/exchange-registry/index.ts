import registryJson from "@/config/exchange-registry.json";
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
  return {
    address,
    name,
    domain,
    requiresMediator,
    requiresMemo,
    memoType: memoType as RegistryEntry["memoType"],
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

const registry = parseRegistry(registryJson);
const entries = registry.entries;
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
