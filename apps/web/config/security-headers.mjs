// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.
// The Content-Security-Policy is not here. The app and sign-in routes carry a per-request nonce,
// so proxy.ts sets theirs; each prerendered marketing page gets one hashing its own inline scripts,
// written after the build by scripts/marketing-csp.mjs into the Build Output config Vercel serves
// (or the routes manifest, for `next start`).

const YOUTUBE_EMBED = '"https://www.youtube-nocookie.com"';

/**
 * Only what the app uses is allowed: clipboard writes (copy buttons, the receipt export) and the
 * YouTube embed's copy and fullscreen. Every powerful feature it does not use is refused, for
 * this page and every frame in it. Browser extension wallets are not governed by this header.
 * WebUSB is opened to this origin only on the routes that sign (`SIGNING_ROUTE_SOURCES`), for a
 * Ledger. The kit's Ledger module uses WebUSB alone, so `hid` stays refused everywhere.
 * Passkey key-owner sign-in (#770) would need `publickey-credentials-get` opened to self.
 *
 * @param {string} usb the allowlist WebUSB gets
 * @returns {string}
 */
function permissionsPolicy(usb) {
  return [
    `clipboard-write=(self ${YOUTUBE_EMBED})`,
    `fullscreen=(self ${YOUTUBE_EMBED})`,
    "camera=()",
    "microphone=()",
    "geolocation=()",
    "payment=()",
    `usb=${usb}`,
    "hid=()",
    "serial=()",
    "bluetooth=()",
    "midi=()",
    "display-capture=()",
    "clipboard-read=()",
    "publickey-credentials-create=()",
    "publickey-credentials-get=()",
  ].join(", ");
}

const PERMISSIONS_POLICY = permissionsPolicy("()");

/** The policy of the routes that sign: the same, with WebUSB allowed for this origin's own frame. */
export const SIGNING_PERMISSIONS_POLICY = permissionsPolicy("(self)");

/**
 * The routes where a transaction is signed with a connected wallet: every network route (the
 * bare `/mainnet` and `/testnet` included, which `:path*` matches with no segment) and the
 * co-signing station. Nothing else, marketing pages and `/api-keys` included, gets WebUSB.
 */
export const SIGNING_ROUTE_SOURCES = ["/:network(mainnet|testnet)/:path*", "/cosign"];

/**
 * The response headers every route carries, pages and `/api/*` alike.
 *
 * - HSTS: two years, matching what Vercel sends, plus includeSubDomains. The apex's redirect to
 *   www (config/apex-redirect.mjs) carries it too, which is what extends it to every subdomain.
 *   Not preload: a preload entry binds every subdomain for months after removal.
 * - COOP `same-origin-allow-popups`, not `same-origin`: Albedo and the xBull web wallet sign in a
 *   popup that answers through `window.opener`, which `same-origin` would sever.
 * - Referrer: other origins see the origin only, never a path that names an account.
 * - Reporting-Endpoints: where the CSP's `report-to csp` sends violation reports.
 *
 * @type {ReadonlyArray<{ key: string, value: string }>}
 */
export const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Reporting-Endpoints", value: 'csp="/api/csp-report"' },
];

/**
 * The header rules that replace the Permissions-Policy on the signing routes. They must come after
 * the rule that sets `SECURITY_HEADERS` on every route: when two rules set the same key, Next (and
 * the Build Output config Vercel serves) keeps the later one.
 *
 * @type {ReadonlyArray<{ source: string, headers: Array<{ key: string, value: string }> }>}
 */
export const SIGNING_HEADER_RULES = SIGNING_ROUTE_SOURCES.map((source) => ({
  source,
  headers: [{ key: "Permissions-Policy", value: SIGNING_PERMISSIONS_POLICY }],
}));
