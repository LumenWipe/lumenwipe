// Stellar protocol constants
export const BASE_RESERVE_XLM = 0.5; // XLM per subentry
export const ACCOUNT_BASE_RESERVE_XLM = 1.0; // base account reserve
export const OP_BATCH_LIMIT = 100; // max operations per transaction
export const BASE_FEE_STROOPS = 100; // per operation
export const TX_TIMEOUT_SECONDS = 300; // 5 minutes
export const POLL_INTERVAL_MS = 3000; // 3 seconds between polls
export const POLL_MAX_ATTEMPTS = 30; // 90 seconds total
export const SLIPPAGE_BPS = 50; // 0.5% default slippage for path payments
export const SE_API_TIMEOUT_MS = 10000; // 10 seconds
export const SE_API_MAX_RETRIES = 3;

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
