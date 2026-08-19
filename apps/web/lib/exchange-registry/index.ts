import embedded from "@registry/exchange-registry.json";

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

/** Shape-checks one served entry. An `as` cast would let `entries: [null]` reach the render
 *  path and throw a TypeError there instead. */
function isUsableEntry(e: unknown): e is RegistryEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.address === "string" &&
    r.address.startsWith("G") &&
    r.address.length === 56 &&
    typeof r.name === "string" &&
    typeof r.requiresMediator === "boolean" &&
    typeof r.requiresMemo === "boolean" &&
    (r.memoType === "text" || r.memoType === "id" || r.memoType === "hash")
  );
}

/**
 * Merges a served entry over its embedded counterpart, allowing only tightening.
 *
 * This is the heart of the thing. Serving the registry moved `verify()`'s memo expectation -
 * previously the one input that came from neither the user nor the API - onto the API itself,
 * which is exactly the circularity the trust anchor exists to avoid. A hostile response could
 * return the real Coinbase entry with `requiresMemo: false`: the UI would ask for no memo,
 * `isCexAddress` would still be true so the unrecognized-destination confirmation would not
 * appear either, and `verify()` would compute `memoRequired: false` and demand nothing. The
 * user signs, the exchange receives an unattributable payment, and the source account is gone.
 *
 * So the served copy is an upper bound on trust, not a replacement: for an address the bundle
 * already knows, a served entry may only make the rules STRICTER. Relaxing one is refused and
 * the embedded entry stands. Addresses the bundle does not know are purely additive - that is
 * the whole point of serving it, and adding an exchange can only ever add protection.
 */
function tightenedOver(embeddedEntry: RegistryEntry, servedEntry: RegistryEntry): RegistryEntry {
  return {
    ...servedEntry,
    requiresMemo: embeddedEntry.requiresMemo || servedEntry.requiresMemo,
    requiresMediator: embeddedEntry.requiresMediator || servedEntry.requiresMediator,
    // A memo type may be corrected (text -> id is a real, common change) but only while the
    // requirement itself stands; it cannot be used to smuggle in "no memo".
    memoType: servedEntry.memoType,
  };
}

/** How far past the embedded copy's own expiry a served payload may extend validity. Without
 *  this the endpoint self-attests its freshness and the expiry gate constrains nobody. */
const MAX_EXTENSION_DAYS = 120;

/** The registry is small and served from our own API; anything slower than this is a stall,
 *  not a slow response. */
const REGISTRY_FETCH_TIMEOUT_MS = 8_000;

function boundedValidUntil(embeddedUntil: string, servedUntil: string): string {
  const embedded = Date.parse(`${embeddedUntil}T23:59:59Z`);
  const served = Date.parse(`${servedUntil}T23:59:59Z`);
  if (!Number.isFinite(served)) return embeddedUntil;
  // Never adopt an expiry EARLIER than the bundle's own. The two deploy independently, so the
  // web can ship a freshly re-verified registry while the API still serves the previous one;
  // taking the older date would block exchange closes using rules the page in front of the
  // user has current. Bounded above so the endpoint cannot extend its own validity forever.
  const cap = embedded + MAX_EXTENSION_DAYS * 86_400_000;
  if (served < embedded) return embeddedUntil;
  return served <= cap ? servedUntil : embeddedUntil;
}

/**
 * Fetches the served registry and merges it over the bundled floor.
 *
 * A failure is not fatal - the floor stays in place, and whether it may be relied on is decided
 * by its own expiry rather than by whether this call succeeded. What must never happen is
 * adopting a payload with no freshness fields: with nothing to expire, the fail-closed gate
 * silently becomes a no-op.
 */
export async function loadServedRegistry(
  // Narrower than `typeof fetch` on purpose: this only ever GETs one path, and the full
  // signature drags in properties (`preconnect`) a test double has no reason to implement.
  fetchImpl: (input: string) => Promise<Response> = (input) =>
    fetch(input, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) })
): Promise<RegistrySnapshot> {
  try {
    // Bounded. A failure degrades to the floor, but a hang does not degrade at all - the
    // analyze page awaits this between the account read and the plan fetch, so an endpoint
    // that accepts the connection and never answers leaves the user on the spinner with no
    // error, no retry and no way out but a reload.
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

    const servedEntries = body.entries.filter(isUsableEntry);
    const embeddedByAddress = new Map(EMBEDDED.entries.map((e) => [e.address, e]));
    const merged = new Map(embeddedByAddress);
    for (const servedEntry of servedEntries) {
      const embeddedEntry = embeddedByAddress.get(servedEntry.address);
      merged.set(
        servedEntry.address,
        embeddedEntry ? tightenedOver(embeddedEntry, servedEntry) : servedEntry
      );
    }

    current = {
      // Every embedded address survives: a served payload cannot make the client forget an
      // exchange it already knew, which would turn a known deposit address back into an
      // "unrecognized" one and route it through a confirmation instead of the mediator.
      entries: [...merged.values()],
      lastVerified: body.lastVerified,
      validUntil: boundedValidUntil(EMBEDDED.validUntil, body.validUntil),
      served: true,
    };
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
