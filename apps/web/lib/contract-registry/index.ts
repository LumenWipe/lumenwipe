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
  wasmHash: string | null;
  version: string;
  verifiedLive: boolean;
}

interface Registry {
  validUntil: string;
  /** Per protocol, the code versions registered only to be recognized and refused. */
  noExitVersions?: Record<string, string[]>;
  entries: RegistryEntry[];
}

const REGISTRY = embedded as Registry;

/**
 * Whether an exit or a conversion may touch this entry's contract at all: verified live, pinned
 * to a hash, and not running a version the registry lists in `noExitVersions`. A refused
 * protocol's contract adds nothing an exit may touch, even where `EXIT_FUNCTIONS` would block
 * every call it could receive: its code can change under the same address. An
 * `executable-owner` is listed only so the API verifies the code it hands its pools, never as a
 * contract an exit may reach.
 */
function isExitCapable(entry: RegistryEntry): boolean {
  return (
    entry.kind !== "executable-owner" &&
    entry.verifiedLive &&
    entry.wasmHash !== null &&
    !(REGISTRY.noExitVersions?.[entry.protocol] ?? []).includes(entry.version)
  );
}

/** The registry kinds an exit may call besides the position's own contract. */
export type ExitContractKind = "router" | "backstop" | "stake";

/**
 * The functions an exit may call on each kind of contract, per protocol. A position's contract
 * and the list of tokens come from the API's account read; pinning the functions is what keeps a
 * hostile read from turning a whitelisted contract into an arbitrary call - a router that could
 * be asked to `remove_liquidity` must not be askable to swap, and a pair is never called directly.
 * Blend's `claim` collects BLND emissions from the pool; its backstop's `withdraw` takes out a
 * deposit whose withdrawal queue has run out. Phoenix's `unbond` runs on a third kind, `stake`:
 * a pool's staking is a separate contract (read from the pool's own config, never the position
 * itself), so it is pinned via the registry exactly like Blend's backstop.
 */
export const EXIT_FUNCTIONS: Record<
  DefiPosition["protocol"],
  { position: readonly string[] } & Record<ExitContractKind, readonly string[]>
> = {
  blend: { position: ["submit", "claim"], router: [], backstop: ["withdraw"], stake: [] },
  soroswap: { position: [], router: ["remove_liquidity"], backstop: [], stake: [] },
  aquarius: { position: ["withdraw", "claim"], router: [], backstop: [], stake: [] },
  phoenix: { position: ["withdraw_liquidity"], router: [], backstop: [], stake: ["unbond"] },
  fxdao: { position: ["pay_debt"], router: [], backstop: [], stake: [] },
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
/**
 * The contracts a Soroban token conversion may be entered through on `network`: Soroswap's
 * aggregator and router, and xBull's router. Bundled, never served, for the same reason the exit
 * contracts are - an API that could add an address here could name its own. Empty when the
 * registry has expired, so a conversion through an unverified contract fails verification rather
 * than slipping through.
 */
export function conversionContractsFor(network: Network, now: Date = new Date()): string[] {
  if (!isContractRegistryUsable(now)) return [];
  return REGISTRY.entries
    .filter(
      (e) =>
        e.network === network &&
        (e.protocol === "soroswap" || e.protocol === "xbull") &&
        // A hash-less entry is one nobody resolved on-chain; the API refuses those too.
        isExitCapable(e) &&
        (e.kind === "aggregator" || e.kind === "router")
    )
    .map((e) => e.address);
}

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
        isExitCapable(e) &&
        wanted.has(e.protocol) &&
        EXIT_FUNCTIONS[e.protocol as DefiPosition["protocol"]][kind].length > 0
    )
    .map((e) => ({ address: e.address, protocol: e.protocol as DefiPosition["protocol"] }));
}

/**
 * Every contract the bundled registry names on `network`. An exit through one of these may move
 * the account's own XLM and classic assets; an exit through any other contract may not. Empty
 * when the registry has expired.
 */
export function registryContractsFor(network: Network, now: Date = new Date()): string[] {
  if (!isContractRegistryUsable(now)) return [];
  return REGISTRY.entries
    .filter((e) => e.network === network && isExitCapable(e))
    .map((e) => e.address);
}
