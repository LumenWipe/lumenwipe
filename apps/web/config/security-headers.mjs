// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.
// The Content-Security-Policy is not here: it carries a per-request nonce, so proxy.ts sets it.

const YOUTUBE_EMBED = '"https://www.youtube-nocookie.com"';

/**
 * Only what the app uses is allowed: clipboard writes (copy buttons, the receipt export) and the
 * YouTube embed's copy and fullscreen. Every powerful feature it does not use is refused, for
 * this page and every frame in it. Browser extension wallets are not governed by this header.
 * Ledger (#736) needs `hid` and `usb` opened to self.
 * Passkey key-owner sign-in (#770) would need `publickey-credentials-get` opened to self.
 */
const PERMISSIONS_POLICY = [
  `clipboard-write=(self ${YOUTUBE_EMBED})`,
  `fullscreen=(self ${YOUTUBE_EMBED})`,
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "hid=()",
  "serial=()",
  "bluetooth=()",
  "midi=()",
  "display-capture=()",
  "clipboard-read=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
].join(", ");

/**
 * The response headers every route carries, pages and `/api/*` alike.
 *
 * - HSTS: two years, matching what Vercel sends, plus includeSubDomains. Not preload: the apex is
 *   a host-level redirect this app never serves, and a preload entry binds every subdomain for
 *   months after removal.
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
