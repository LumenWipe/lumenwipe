import { NextRequest, NextResponse } from "next/server";
import { refuseUnknownNetwork } from "@/lib/api/network-segment";

// The kit's WalletConnect module (@reown/appkit/core + @walletconnect/sign-client)
// talks to these hosts directly - verified against its source, not guessed:
// the session relay, Reown's wallet explorer/analytics, and its "Verify API"
// iframe that shows a connecting wallet this dApp is legitimate.
const WALLET_CONNECT_RELAY_HOSTS = "wss://relay.walletconnect.org wss://relay.walletconnect.com";
const WALLET_CONNECT_AUX_HOSTS =
  "https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com";
const WALLET_CONNECT_VERIFY_HOSTS =
  "https://verify.walletconnect.com https://verify.walletconnect.org";
// Umami Cloud's collection endpoint - the script (layout.tsx) loads from cloud.umami.is, but
// sends every pageview/event beacon to this separate gateway host. Without it here, the script
// loads fine and every beacon it sends is silently blocked by connect-src.
const UMAMI_HOSTS = "https://gateway.umami.is";
// Pollar's SDK (the API keys page social login) calls these hosts directly from the browser.
const POLLAR_HOSTS = "https://sdk.api.pollar.xyz https://server.api.pollar.xyz";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const refused = refuseUnknownNetwork(pathname);
  if (refused) return refused;
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Next.js's dev-mode webpack build wraps every client module in eval() for fast
  // source maps - script-src needs 'unsafe-eval' only in development. The
  // production bundle never uses eval() and stays fully strict.
  const scriptSrcEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${scriptSrcEval}`,
    // The wallet kit's connect modal renders via twind (runtime CSS-in-JS),
    // which injects <style> tags with no nonce support - the one deliberate
    // exception here. script-src stays strict (no unsafe-inline, no unsafe-eval).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self' ${WALLET_CONNECT_RELAY_HOSTS} ${WALLET_CONNECT_AUX_HOSTS} ${UMAMI_HOSTS} ${POLLAR_HOSTS}`,
    `frame-src ${WALLET_CONNECT_VERIFY_HOSTS} https://www.youtube-nocookie.com`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
    // Violation reports go to the Reporting-Endpoints entry named csp (config/security-headers.mjs).
    `report-to csp`,
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets and image optimization. The JSON API routes carry no HTML/inline
    // scripts, so they get no nonce or CSP header: they match only for the network check.
    // The prerendered marketing pages are skipped too, with their RSC payloads: the build gives
    // each one a hash-based policy (scripts/marketing-csp.mjs), and a proxy run would cost every
    // CDN hit a function call. Exact paths only, so an unknown /blog slug still gets the nonce
    // policy; a new post needs its line here (tests/unit/proxy-matcher.test.ts). The blog's feed
    // is prerendered XML with no script, skipped the same way.
    "/((?!_next/static|_next/image|favicon|api/|(?:(?:|faq|how-it-works|security|stats|registry|content|playground|blog|blog/feed\\.xml|blog/account-merge-on-stellar|blog/cant-merge-a-stellar-account-because-of-extra-signers|blog/how-do-i-cancel-open-offers-on-stellar|blog/how-do-i-remove-a-trustline-on-stellar|blog/phase-0-launch|blog/phase-1-launch|blog/phase-2-launch|blog/what-are-stellar-data-entries|blog/why-cant-i-merge-my-stellar-account-claimable-balances)(?:\\.rsc|\\.segments/.*)?|index(?:\\.rsc|\\.segments/.*))$).*)",
    "/api/:path*",
  ],
};
