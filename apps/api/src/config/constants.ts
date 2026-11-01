// Stellar protocol constants
export const BASE_RESERVE_XLM = 0.5; // XLM per subentry
export const ACCOUNT_BASE_RESERVE_XLM = 1.0; // base account reserve
export const OP_BATCH_LIMIT = 100; // max operations per transaction
export const BASE_FEE_STROOPS = 100; // per operation
export const TX_TIMEOUT_SECONDS = 300; // 5 minutes
export const CLAIM_PREDICATE_MARGIN_SECONDS = TX_TIMEOUT_SECONDS + 60;
// Sized against the SDK's 25-round ceiling: 15 claim rounds plus the close leaves headroom.
export const CLAIMABLE_BALANCE_READ_CEILING = 1500;
export const CLAIM_ROUND_BATCH_SIZE = 100;
export const POLL_INTERVAL_MS = 3000; // 3 seconds between polls
export const POLL_MAX_ATTEMPTS = 30; // 90 seconds total
export const SLIPPAGE_BPS = 50; // 0.5% default slippage for path payments
export const HORIZON_TIMEOUT_MS = 10000; // 10 seconds
// One inbound request's budget for every upstream read it makes together; the web proxy's
// maxDuration is 55 s, so the API answers (with a typed error) before the proxy gives up.
export const REQUEST_DEADLINE_MS = 40_000;
export const RPC_READ_TIMEOUT_MS = 10_000;
// About six ledgers: an RPC whose newest ledger is older than this has fallen behind the network.
export const RPC_MAX_LEDGER_AGE_SECONDS = 30;
export const RPC_SIMULATE_TIMEOUT_MS = 20_000;
// OctoPos is an optional enhancement - fail fast into degraded mode rather than stall the
// analyze call waiting on a third-party DeFi position provider. Combined with the 1-retry
// budget in octopos-http.ts, worst case is 2 * 2500ms + one 300ms backoff ~= 5.3s, leaving
// headroom under the web proxy's maxDuration for the direct-read fallback that can follow.
export const OCTOPOS_TIMEOUT_MS = 2500; // 2.5 seconds
// architecture.md §7.2 caches DeFi positions for "tens of seconds," and OctoPos's own Position
// Tracker refreshes every 60s (per its architecture docs) - double that, tight enough to catch a
// genuinely stalled feed, generous enough not to block a plan on ordinary refresh latency.
export const DEFI_POSITIONS_STALENESS_THRESHOLD_SECONDS = 120;

// Sponsorship enumeration: how many of the sponsor's own operations we'll page through
// (oldest-first, from account creation) looking for sponsorship-bracket candidates
// before giving up and flagging the read as incomplete. 2000 = 10 pages at 200/page.
export const SPONSORSHIP_MAX_OPERATIONS_SCANNED = 2000;

// Playground: a freshly friendbot-funded account is visible on Horizon immediately
// but the Soroban RPC lags a few ledgers behind ingesting it. Retry getAccount
// until the RPC catches up before building the first transaction.
export const ACCOUNT_VISIBILITY_MAX_ATTEMPTS = 7; // ~12s of patience with the delay below
export const ACCOUNT_VISIBILITY_DELAY_MS = 2000;

// Playground: consecutive mess steps submit from the same account in quick
// succession against the load-balanced public Soroban RPC. When the node that
// serves a request lags the just-confirmed state, the network rejects the next
// tx as tx_bad_seq (stale sequence) or tx_no_account (source not yet ingested on
// that node). Re-read and resubmit a few times, giving the RPC a moment to catch
// up between attempts.
export const SUBMIT_RETRY_MAX_ATTEMPTS = 5;
export const SUBMIT_RETRY_DELAY_MS = 2500; // ~10s of total patience across retries

// XLM stroops per lumen
export const STROOPS_PER_XLM = 10_000_000;
/** Plan-time fee estimate for one Soroban exit transaction. Resource fees dwarf the classic base
 *  fee (a Blend withdraw on testnet charged ~25,000 stroops); this is a deliberate over-estimate
 *  so the review page never understates what a close with positions will cost. */
export const SOROBAN_EXIT_FEE_ESTIMATE_STROOPS = 100_000;
/** Ceiling on the total fee of one exit transaction as assembled from simulation. A real exit
 *  costs a few thousand stroops; a fee anywhere near this is a simulation gone wrong or an
 *  attempt to grief the account through the fee pool, and is refused rather than offered. */
export const MAX_SOROBAN_EXIT_FEE_STROOPS = 10_000_000; // 1 XLM
/** Extra CPU instructions requested when simulating an exit. Protocols that accrue rewards by
 *  ledger time do slightly more work at execution than at simulation (an Aquarius withdraw ran
 *  21 instructions over its 15.1M budget), and the network rejects the whole transaction. */
export const EXIT_SIMULATION_CPU_LEEWAY = 1_000_000;
/** Ceiling on the outer fee of one fee-bump transaction: the sponsor pays the base fee for at
 *  most a full 100-operation inner transaction plus the fee-bump itself, never more. */
export const MAX_FEE_BUMP_STROOPS = (OP_BATCH_LIMIT + 1) * BASE_FEE_STROOPS;
/** What the fee sponsor will pay per UTC day, per inner transaction source, per API key, and in
 *  total. A reserve-locked account needs a handful of sponsored rounds to close; the totals keep
 *  the fee account's float from being spent faster than an operator can notice and top it up. */
export const FEE_BUMP_DAILY_BUDGET_PER_SOURCE_STROOPS = 25 * MAX_FEE_BUMP_STROOPS;
export const FEE_BUMP_DAILY_BUDGET_PER_KEY_STROOPS = 50_000_000; // 5 XLM
export const FEE_BUMP_DAILY_BUDGET_TOTAL_STROOPS = 200_000_000; // 20 XLM
/** Longest validity a co-signed or sponsored envelope may have left: the window every envelope
 *  is built with, plus slack for clock drift between the builder and the signer. */
export const MAX_SIGNED_VALIDITY_SECONDS = TX_TIMEOUT_SECONDS + 30;
export const MIN_MEDIATOR_FORWARD_STROOPS = 10_000_000n; // 1 XLM
