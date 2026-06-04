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

// XLM stroops per lumen
export const STROOPS_PER_XLM = 10_000_000;
