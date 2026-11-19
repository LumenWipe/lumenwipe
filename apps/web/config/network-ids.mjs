// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

/** Every network the app serves, as its first path segment. */
export const NETWORK_IDS = /** @type {const} */ (["mainnet", "testnet"]);

/**
 * Serves the global 404 for a single unknown path segment, which would otherwise reach the
 * `[network]` segment and fail there with Next's bare error shell. An afterFiles rewrite runs after
 * every page, route handler and public file and before the dynamic routes, so it never shadows a
 * real route. The `$` sits inside the parameter because the Vercel adapter drops the rule's own end
 * anchor; a `.` after a network leaves its `.rsc` requests alone.
 */
export const UNKNOWN_SEGMENT_REWRITE = {
  source: `/:segment((?!(?:${NETWORK_IDS.join("|")})(?:[.]|$))[^/]+$)`,
  destination: "/_not-found",
};
