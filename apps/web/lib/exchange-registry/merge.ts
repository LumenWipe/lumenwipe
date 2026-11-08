/**
 * The stricter-only merge of a served exchange registry over the bundled one, as pure functions:
 * no network, no module state, no bundled data. The web runs it when the served copy arrives
 * (`loadServedRegistry`), and the verifier runs it per call when an integrator passes a snapshot,
 * so both apply exactly the same rules.
 */

export interface RegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash";
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
 * the whole point of serving it: a new address gains its memo rule and the
 * unrecognized-destination confirmation stops applying, but it never enables the mediated
 * hand-off (`mediatorAllowedFor`).
 */
function tightenedOver(embeddedEntry: RegistryEntry, servedEntry: RegistryEntry): RegistryEntry {
  return {
    ...servedEntry,
    requiresMemo: embeddedEntry.requiresMemo || servedEntry.requiresMemo,
    requiresMediator: embeddedEntry.requiresMediator || servedEntry.requiresMediator,
    // Never taken from the served copy. A memo sent under the wrong type reaches the right
    // address and is credited to nobody, so a served type that differs is recorded as a dispute
    // (`mergeServedRegistry`) and the close is refused until the bundled copy is updated.
    memoType: embeddedEntry.memoType,
  };
}

/** How far past the embedded copy's own expiry a served payload may extend validity. Without
 *  this the endpoint self-attests its freshness and the expiry gate constrains nobody. */
const MAX_EXTENSION_DAYS = 120;

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

/** The part of a registry the merge reads from the bundled copy. */
export interface RegistryFloor {
  entries: readonly RegistryEntry[];
  validUntil: string;
}

/** A served registry after the merge: the entries and dates to rely on. */
export interface MergedRegistry {
  entries: RegistryEntry[];
  lastVerified: string;
  validUntil: string;
  /** Bundled addresses the served copy lists with a different memo type. */
  memoTypeDisputes: string[];
}

/**
 * Merges a served registry payload over the bundled floor, or returns null when the payload is
 * not a registry at all (not an object, no `entries` array, no freshness fields). The caller
 * decides what null means: the web keeps the copy it already holds, the verifier refuses.
 *
 * Every bundled address survives with rules at least as strict as its own, a served address the
 * bundle does not know is added as served, a malformed entry is dropped, and the validity date
 * only moves later, by at most {@link MAX_EXTENSION_DAYS}. A bundled address the served copy
 * lists with another memo type keeps the bundled type and is listed in `memoTypeDisputes`.
 */
export function mergeServedRegistry(floor: RegistryFloor, body: unknown): MergedRegistry | null {
  if (typeof body !== "object" || body === null) return null;
  const served = body as { entries?: unknown; lastVerified?: unknown; validUntil?: unknown };
  if (
    !Array.isArray(served.entries) ||
    typeof served.lastVerified !== "string" ||
    typeof served.validUntil !== "string"
  ) {
    return null;
  }

  const embeddedByAddress = new Map(floor.entries.map((e) => [e.address, e]));
  const merged = new Map(embeddedByAddress);
  const disputes = new Set<string>();
  for (const servedEntry of served.entries.filter(isUsableEntry)) {
    const embeddedEntry = embeddedByAddress.get(servedEntry.address);
    if (embeddedEntry && embeddedEntry.memoType !== servedEntry.memoType) {
      disputes.add(servedEntry.address);
    }
    merged.set(
      servedEntry.address,
      embeddedEntry ? tightenedOver(embeddedEntry, servedEntry) : servedEntry
    );
  }

  return {
    entries: [...merged.values()],
    lastVerified: served.lastVerified,
    validUntil: boundedValidUntil(floor.validUntil, served.validUntil),
    memoTypeDisputes: [...disputes],
  };
}

/** Whether a registry valid until `validUntil` (YYYY-MM-DD, inclusive) may still be relied on at
 *  `now`. An unparseable date is never usable. */
export function isUsableAt(validUntil: string, now: Date): boolean {
  const until = Date.parse(`${validUntil}T23:59:59Z`);
  return Number.isFinite(until) && now.getTime() <= until;
}

export { isUsableEntry, tightenedOver, MAX_EXTENSION_DAYS, boundedValidUntil };
