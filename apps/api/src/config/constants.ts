// Stellar protocol constants
export const BASE_RESERVE_XLM = 0.5; // XLM per subentry
export const ACCOUNT_BASE_RESERVE_XLM = 1.0; // base account reserve
export const OP_BATCH_LIMIT = 100; // max operations per transaction
export const BASE_FEE_STROOPS = 100; // per operation
export const TX_TIMEOUT_SECONDS = 300; // 5 minutes
export const POLL_INTERVAL_MS = 3000; // 3 seconds between polls
export const POLL_MAX_ATTEMPTS = 30; // 90 seconds total
export const SLIPPAGE_BPS = 50; // 0.5% default slippage for path payments
export const HORIZON_TIMEOUT_MS = 10000; // 10 seconds
// OctoPos is an optional enhancement - fail fast into degraded mode rather than stall the
// analyze call waiting on a third-party DeFi position provider.
export const OCTOPOS_TIMEOUT_MS = 5000; // 5 seconds
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
