// Safety caps on what one session may build, enforced by the validator wherever a selection is
// accepted. The market maker funds each demo with its selection's cost plus DEMO_HEADROOM_XLM, so
// the XLM cap also bounds what one session draws from it.
export const MAX_SCENARIOS = 8;
export const MAX_SUB_ENTRIES = 30;
export const MAX_SESSION_XLM = 50;
export const MAX_SOROBAN_TRANSACTIONS = 6;
export const MAX_ESTIMATED_SECONDS = 6 * 60;
