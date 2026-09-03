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

/** The registry kinds an exit may call besides the position's own contract. */
export type ExitContractKind = "router" | "backstop";

/**
 * The functions an exit may call on each kind of contract, per protocol. A position's contract
 * and the list of tokens come from the API's account read; pinning the functions is what keeps a
 * hostile read from turning a whitelisted contract into an arbitrary call - a router that could
 * be asked to `remove_liquidity` must not be askable to swap, and a pair is never called directly.
 * Blend's `claim` collects BLND emissions from the pool; its backstop's `withdraw` takes out a
 * deposit whose withdrawal queue has run out.
 */
export const EXIT_FUNCTIONS: Record<
  DefiPosition["protocol"],
  { position: readonly string[] } & Record<ExitContractKind, readonly string[]>
> = {
  blend: { position: ["submit", "claim"], router: [], backstop: ["withdraw"] },
  soroswap: { position: [], router: ["remove_liquidity"], backstop: [] },
  aquarius: { position: ["withdraw", "claim"], router: [], backstop: [] },
  phoenix: { position: [], router: [], backstop: [] },
  fxdao: { position: [], router: [], backstop: [] },
};

export function isContractRegistryUsable(now: Date = new Date()): boolean {
  const until = Date.parse(`${REGISTRY.validUntil}T23:59:59Z`);
  return Number.isFinite(until) && now.getTime() <= until;
}

/**
 * The protocol contracts of one `kind` an exit of one of `protocols` may invoke on `network` -
 * only for protocols whose exit actually calls that kind (an Aquarius position is called directly,
 * so its router is never a target even though the registry lists it). Empty when the registry has
 * expired: an exit through an unverified contract must fail verification, not slip through.
 */
export function exitContractsFor(
  network: Network,
  protocols: Iterable<DefiPosition["protocol"]>,
  kind: ExitContractKind,
  now: Date = new Date()
): Array<{ address: string; protocol: DefiPosition["protocol"] }> {
  if (!isContractRegistryUsable(now)) return [];
  const wanted = new Set<string>(protocols);
  return REGISTRY.entries
    .filter(
      (e) =>
        e.network === network &&
        e.kind === kind &&
        e.verifiedLive &&
        wanted.has(e.protocol) &&
        EXIT_FUNCTIONS[e.protocol as DefiPosition["protocol"]][kind].length > 0
    )
    .map((e) => ({ address: e.address, protocol: e.protocol as DefiPosition["protocol"] }));
}
