import embedded from "@registry/contract-registry.json";
import type { Network } from "@/config/networks";
import type { DefiPosition } from "@/types/account";

/**
 * The contract registry, as the browser uses it: only to name the protocol contracts a DeFi exit
 * may invoke besides the position itself (a router, for an AMM withdrawal).
 *
 * Deliberately the BUNDLED copy, never a served one. The exchange registry is served because a
 * stale entry there destroys funds and a served entry can only tighten a rule. Here the opposite
 * holds: an entry names a contract the user will be asked to authorize, so an API that could add
 * one could add its own. A router reaches this list only through a code review and a web deploy,
 * and past `validUntil` the list is empty - exits that need a router are refused rather than
 * verified against a registry nobody has re-checked.
 */

interface RegistryEntry {
  network: string;
  protocol: string;
  kind: string;
  address: string;
  verifiedLive: boolean;
}

const REGISTRY = embedded as { validUntil: string; entries: RegistryEntry[] };

export function isContractRegistryUsable(now: Date = new Date()): boolean {
  const until = Date.parse(`${REGISTRY.validUntil}T23:59:59Z`);
  return Number.isFinite(until) && now.getTime() <= until;
}

/**
 * The routers an exit of one of `protocols` may invoke on `network`. Empty when the registry has
 * expired: an exit through an unverified router must fail verification, not slip through.
 */
export function exitRoutersFor(
  network: Network,
  protocols: Iterable<DefiPosition["protocol"]>,
  now: Date = new Date()
): string[] {
  if (!isContractRegistryUsable(now)) return [];
  const wanted = new Set<string>(protocols);
  return REGISTRY.entries
    .filter(
      (e) =>
        e.network === network && e.kind === "router" && e.verifiedLive && wanted.has(e.protocol)
    )
    .map((e) => e.address);
}
