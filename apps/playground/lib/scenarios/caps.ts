// Safety caps on what one session may build, enforced by the validator wherever a selection is
// accepted. The XLM cap sits well under the 100 XLM the demo keeps (DEMO_KEEP_XLM), so the account
// can always pay for what it builds.
export const MAX_SCENARIOS = 8;
export const MAX_SUB_ENTRIES = 30;
export const MAX_SESSION_XLM = 50;
export const MAX_SOROBAN_TRANSACTIONS = 6;
export const MAX_ESTIMATED_SECONDS = 6 * 60;
export const MAX_BATCH_SIZE = 3;
