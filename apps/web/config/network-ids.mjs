// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

/** Every network the app serves, as its first path segment. */
export const NETWORK_IDS = /** @type {const} */ (["mainnet", "testnet"]);

/**
 * A path no route serves: a segment that starts with `_` is a private folder in the app router, so
 * it is never a static route, and no dynamic route has two segments that both follow `[network]`.
 */
export const UNMATCHED_PATH = "/_unmatched/_unmatched";

/**
 * Sends a single unknown path segment, which would otherwise reach the `[network]` segment and fail
 * there with Next's bare error shell, to a path no route serves. The request then takes the same
 * miss as any deeper unknown path: Next's server and Vercel's error route both answer it with the
 * global 404 and status 404. Rewriting to `/_not-found` itself would hit that page as a file, which
 * Vercel serves with status 200. An afterFiles rewrite runs after every page, route handler and
 * public file and before the dynamic routes, so it never shadows a real route. The `$` sits inside
 * the parameter because the Vercel adapter drops the rule's own end anchor; a `.` after a network
 * leaves its `.rsc` requests alone.
 */
export const UNKNOWN_SEGMENT_REWRITE = {
  source: `/:segment((?!(?:${NETWORK_IDS.join("|")})(?:[.]|$))[^/]+$)`,
  destination: UNMATCHED_PATH,
};
