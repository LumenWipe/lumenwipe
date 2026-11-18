// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

export const CANONICAL_ORIGIN = "https://www.lumenwipe.com";

/**
 * The apex is served by this project only to send every path, query kept, to the same path on
 * www with a 308. The app answers it, not a Vercel domain redirect, so the response carries the
 * app's HSTS with includeSubDomains (config/security-headers.mjs) from the apex itself.
 * `has.value` is an anchored regex to both Next and Vercel's router, so the dot is escaped:
 * the host must be exactly the apex. www and preview hosts never match.
 */
export const APEX_REDIRECT = {
  source: "/:path*",
  has: [{ type: "host", value: "lumenwipe\\.com" }],
  destination: `${CANONICAL_ORIGIN}/:path*`,
  permanent: true,
};
