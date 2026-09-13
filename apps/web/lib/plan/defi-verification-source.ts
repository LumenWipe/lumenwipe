export type DefiVerificationLabel = "octopos" | "lumenwipe" | null;

/**
 * Mirrors resolve-defi-positions.ts's source vocabulary (apps/api's DEGRADED_SOURCE and
 * DEGRADED_SOURCE_CONFIRMED_EMPTY constants) as plain string literals - the web never imports
 * the API's closing/detection modules (the boundary lint in .eslintrc.json), the same reason
 * resolvable-blockers.ts hardcodes blocker codes rather than importing them.
 */
const OCTOPOS_SOURCES = new Set(["snapshot", "empty", "cache"]);
const LUMENWIPE_SOURCES = new Set([
  "octopos-degraded-direct-read-confirmed-empty",
  "testnet-direct-read",
]);

/**
 * Which party actually confirmed this account's DeFi position data, for display only - never
 * used for gating (positions-gate.ts already decided that server-side). A totally unconfirmed
 * degraded result (`octopos-degraded-fallback`, an unrecognized source, or "not-tracked" -
 * which the API never returns as a terminal value, but a stale client shouldn't crash on it
 * either) gets no label: nothing was actually verified there, so no "verified by" claim is made.
 */
export function defiVerificationLabel(source: string): DefiVerificationLabel {
  if (OCTOPOS_SOURCES.has(source)) return "octopos";
  if (LUMENWIPE_SOURCES.has(source)) return "lumenwipe";
  return null;
}
