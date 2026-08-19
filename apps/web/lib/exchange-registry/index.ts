import embedded from "@config/exchange-registry.json";

/**
 * The exchange registry, as the browser sees it.
 *
 * The registry decides three things: whether a destination routes through the mediator, whether
 * a memo is required and of which type, and what name to show. It does NOT supply the
 * destination address - the user always types that. So a wrong registry can cause funds to be
 * *destroyed* (sent somewhere uncreditable) but not *diverted* to an attacker, and that is what
 * makes serving it acceptable rather than reckless.
 *
 * It is served by the API rather than shipped in the bundle, because a stale registry and a
 * compromised one do the same damage - and staleness needs only time, while compromise needs an
 * attacker. The file below is the same artifact the API serves, kept here as a floor for when
 * the endpoint is unreachable, never as truth: its age is surfaced, and it stops being usable
 * on the same date.
 */

export interface RegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash";
}

export interface RegistrySnapshot {
  entries: RegistryEntry[];
  lastVerified: string;
  validUntil: string;
  /** True when this came from the API; false when it is the bundled floor. */
  served: boolean;
}

function snapshotFrom(
  data: { entries: unknown; lastVerified: string; validUntil: string },
  served: boolean
): RegistrySnapshot {
  return {
    entries: data.entries as RegistryEntry[],
    lastVerified: data.lastVerified,
    validUntil: data.validUntil,
    served,
  };
}

const EMBEDDED: RegistrySnapshot = snapshotFrom(embedded, false);

// Module-level, because `verify()` is synchronous and runs immediately before signing: it
// cannot await a fetch at that moment. The flow loads the registry earlier (analyze time) and
// this is what every later lookup reads.
let current: RegistrySnapshot = EMBEDDED;

/** Replaces the active snapshot. Called once the API's copy has been fetched. */
export function setRegistry(snapshot: RegistrySnapshot): void {
  current = snapshot;
}

/** The snapshot in use, so the UI can show where it came from and how old it is. */
export function activeRegistry(): RegistrySnapshot {
  return current;
}

/**
 * Whether the active registry may still be relied on.
 *
 * Fail closed: past `validUntil` this returns false and the exchange path must refuse, rather
 * than proceed on data nobody has checked. An exchange close that proceeds on a stale memo rule
 * succeeds on-chain and is credited to nobody - there is no error and no source account left to
 * investigate from, which is precisely the outcome worth refusing over.
 */
export function isRegistryUsable(now: Date = new Date()): boolean {
  const until = Date.parse(`${current.validUntil}T23:59:59Z`);
  return Number.isFinite(until) && now.getTime() <= until;
}

/**
 * Fetches the served registry and adopts it.
 *
 * A failure is not fatal on its own - the bundled floor stays in place and `isRegistryUsable`
 * still governs whether it may be relied on. What must never happen is adopting a payload that
 * is missing its freshness fields: without them there is nothing to expire, and the fail-closed
 * gate silently becomes a no-op.
 */
export async function loadServedRegistry(
  // Narrower than `typeof fetch` on purpose: this only ever GETs one path, and the full
  // signature drags in properties (`preconnect`) a test double has no reason to implement.
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input)
): Promise<RegistrySnapshot> {
  try {
    const res = await fetchImpl("/api/config/exchange-registry");
    if (!res.ok) return current;
    const body = (await res.json()) as Partial<RegistrySnapshot>;
    if (
      !Array.isArray(body.entries) ||
      typeof body.lastVerified !== "string" ||
      typeof body.validUntil !== "string"
    ) {
      return current;
    }
    current = snapshotFrom(
      { entries: body.entries, lastVerified: body.lastVerified, validUntil: body.validUntil },
      true
    );
    return current;
  } catch {
    return current;
  }
}

function byAddress(): Map<string, RegistryEntry> {
  return new Map(current.entries.map((e) => [e.address, e]));
}

export function lookupExchange(address: string): RegistryEntry | null {
  return byAddress().get(address) ?? null;
}

export function isCexAddress(address: string): boolean {
  return byAddress().has(address);
}

export function requiresMediatorForAddress(address: string): boolean {
  return byAddress().get(address)?.requiresMediator ?? false;
}

export function getMemoRequirement(address: string): {
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
} {
  const entry = byAddress().get(address);
  if (!entry) return { requiresMemo: false, memoType: null, exchangeName: null };
  return {
    requiresMemo: entry.requiresMemo,
    memoType: entry.requiresMemo ? entry.memoType : null,
    exchangeName: entry.name,
  };
}
