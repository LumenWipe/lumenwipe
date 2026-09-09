import type { DefiProtocol } from "./defi-position";
import type { PlanBlocker } from "./plan";

/** Where an allowance candidate (token, spender) pair came from before its live amount was
 *  confirmed on the ledger. */
export type AllowanceSource = "events" | "registry";

/**
 * A live, non-zero SEP-41 allowance the account has granted a spender on one token
 * (architecture.md §12). The amount always comes from a live `allowance(from, spender)` read -
 * `approve` neither decrements on spend nor is the only way the amount could have changed since
 * it was set, so the event that discovered the pair is never trusted for the amount itself.
 */
export interface Allowance {
  /** The token contract, `C...`. */
  token: string;
  /** From the token's own `symbol()`, null when it does not answer. */
  tokenSymbol: string | null;
  /** From the token's own `decimals()`, null when it does not answer. */
  tokenDecimals: number | null;
  /** The approved spender. Almost always a contract (`C...`) - a DeFi protocol - but SEP-41's
   *  `approve(from, spender, ...)` types `spender` as `Address`, so a plain account (`G...`) is a
   *  legitimate, if unusual, spender too. */
  spender: string;
  /** The spender's protocol, when its address resolves to a known DeFi contract registry entry
   *  on this network. Null does not mean unsafe - most legitimate spenders (a specific vault, an
   *  integrator's own contract) are simply not in the registry. */
  spenderProtocol: DefiProtocol | null;
  /** Base units, integer string, as `allowance(from, spender)` reports it live on the ledger. */
  amount: string;
  /** The ledger this allowance expires at, from the most recent `approve` event that discovered
   *  this pair. Null when the amount is confirmed live but no `approve` event for this exact pair
   *  was found within the event scan's retention window (e.g. approved long enough ago that the
   *  event has aged out) - the amount is still ground truth, the expiration simply is not
   *  observable from this discovery path, since SEP-41's `allowance()` returns only the amount. */
  expirationLedger: number | null;
  /** Every source that proposed this pair. */
  sources: AllowanceSource[];
}

/** How one candidate source fared, so the interface can say exactly what was consulted. */
export interface AllowanceCoverage {
  source: AllowanceSource;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

/**
 * Every live allowance the account has granted, across every token it has approved anything on.
 * Soroban has no on-chain index of an account's approvals, so this is a best-effort union of
 * candidate (token, spender) pairs - recent `approve` events naming this account as `from`, and
 * the known DeFi contract registry's spenders crossed with a small curated token list - each
 * confirmed by reading `allowance(from, spender)` on the ledger. A zero allowance, live or never
 * granted, is not reported: only what is actually outstanding right now.
 */
export interface AllowancesResult {
  allowances: Allowance[];
  coverage: AllowanceCoverage[];
  /** The ledger range the event scan covered, or null when it ran out of budget before starting. */
  eventsScanned: { fromLedger: number; toLedger: number } | null;
  /** Plain-language warnings: a source that failed, candidates dropped by the cap. */
  warnings: PlanBlocker[];
}
