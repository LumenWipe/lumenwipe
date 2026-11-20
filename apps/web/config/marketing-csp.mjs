// Read by scripts/marketing-csp.mjs after `next build`, so plain JavaScript.
//
// The prerendered marketing pages carry no per-request nonce, so their policy allows inline
// scripts by hash: the exact SHA-256 of each one, computed from that page's build output. No
// 'strict-dynamic': Next loads its chunks with plain <script src> tags, which 'self' covers. The
// wallet and Pollar hosts of the nonce policy (proxy.ts) are left out: no marketing page uses them.

/**
 * The pinned, self-hosted copy of Umami Cloud's tracker (public/a), which 'self' covers. Its
 * beacons go to Umami's collector, the one Umami origin a page may reach.
 */
export const UMAMI_SCRIPT = "/a/u-768ab7ae5fda.js";
const UMAMI_GATEWAY = "https://gateway.umami.is";
const YOUTUBE_EMBED = "https://www.youtube-nocookie.com";

/**
 * The Content-Security-Policy of one marketing page.
 *
 * @param {{ hashes: ReadonlyArray<string>, umami: boolean }} sources the base64 SHA-256 of every
 *   inline script the page runs, and whether it loads Umami's tracker.
 * @returns {string}
 */
export function marketingPolicy({ hashes, umami }) {
  const scriptSrc = [
    "'self'",
    ...[...new Set(hashes)].sort().map((hash) => `'sha256-${hash}'`),
  ].join(" ");
  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self'${umami ? ` ${UMAMI_GATEWAY}` : ""}`,
    `frame-src ${YOUTUBE_EMBED}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
    `report-to csp`,
  ].join("; ");
}
