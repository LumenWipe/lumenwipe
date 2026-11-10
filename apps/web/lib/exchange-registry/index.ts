import embedded from "@registry/exchange-registry.json";
import type { Network } from "@/config/networks";
import {
  appliesOn,
  bundledEntries,
  isUsableAt,
  mergeServedRegistry,
  type RegistryEntry,
} from "./merge";

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

export type { RegistryEntry };

export interface RegistrySnapshot {
  entries: RegistryEntry[];
  lastVerified: string;
  validUntil: string;
  /** True when this came from the API; false when it is the bundled floor. */
  served: boolean;
  /** Listed addresses whose memo type the served copy disputes (see `mergeServedRegistry`).
   *  Absent means none. */
  memoTypeDisputes?: readonly string[];
}

const EMBEDDED: RegistrySnapshot = {
  entries: bundledEntries(embedded.entries),
  lastVerified: embedded.lastVerified,
  validUntil: embedded.validUntil,
  served: false,
};

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

/** The bundled floor, whatever has been served since. What a per-call served snapshot merges
 *  over, so the verifier never depends on what an earlier fetch left in module state. */
export function bundledRegistry(): RegistrySnapshot {
  return EMBEDDED;
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
  return isUsableAt(current.validUntil, now);
}

/** The registry is small and served from our own API; anything slower than this is a stall,
 *  not a slow response. */
const REGISTRY_FETCH_TIMEOUT_MS = 8_000;

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
    const merged = mergeServedRegistry(EMBEDDED, await res.json());
    if (merged === null) return current;

    current = {
      // Every embedded address survives: a served payload cannot make the client forget an
      // exchange it already knew, which would turn a known deposit address back into an
      // "unrecognized" one and route it through a confirmation instead of the mediator.
      entries: merged.entries,
      lastVerified: merged.lastVerified,
      validUntil: merged.validUntil,
      served: true,
      memoTypeDisputes: merged.memoTypeDisputes,
    };
    return current;
  } catch {
    return current;
  }
}

function byAddress(network: Network): Map<string, RegistryEntry> {
  return new Map(current.entries.filter((e) => appliesOn(e, network)).map((e) => [e.address, e]));
}

/** The entry for `address` on `network`, or null. A testnet-only entry is invisible on mainnet. */
export function lookupExchange(address: string, network: Network): RegistryEntry | null {
  return byAddress(network).get(address) ?? null;
}

export function isCexAddress(address: string, network: Network): boolean {
  return byAddress(network).has(address);
}

export function requiresMediatorForAddress(address: string, network: Network): boolean {
  return byAddress(network).get(address)?.requiresMediator ?? false;
}

/** The bundled entry for `address` on `network`, whatever has been served since, or null. */
export function bundledExchange(address: string, network: Network): RegistryEntry | null {
  return EMBEDDED.entries.find((e) => e.address === address && appliesOn(e, network)) ?? null;
}

/**
 * Whether a close to this address may take the mediated hand-off. Only an exchange the bundled
 * registry lists on this network qualifies; a served copy can tighten its rules but cannot add
 * one, and cannot widen a testnet-only entry to mainnet.
 */
export function mediatorAllowedFor(address: string, network: Network): boolean {
  return bundledExchange(address, network)?.requiresMediator === true;
}

/**
 * Whether the served registry gives this listed address a memo type other than the bundled one.
 * Neither copy can be trusted to be the current one, and a memo of the wrong type is credited to
 * nobody, so a close into it is refused until the two agree.
 */
export function memoTypeInDispute(address: string): boolean {
  return current.memoTypeDisputes?.includes(address) ?? false;
}

export function getMemoRequirement(
  address: string,
  network: Network
): {
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
} {
  const entry = byAddress(network).get(address);
  if (!entry) return { requiresMemo: false, memoType: null, exchangeName: null };
  return {
    requiresMemo: entry.requiresMemo,
    memoType: entry.requiresMemo ? entry.memoType : null,
    exchangeName: entry.name,
  };
}
