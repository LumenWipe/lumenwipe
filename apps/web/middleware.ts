import { NextRequest, NextResponse } from "next/server";

// The kit's WalletConnect module (@reown/appkit/core + @walletconnect/sign-client)
// talks to these hosts directly — verified against its source, not guessed:
// the session relay, Reown's wallet explorer/analytics, and its "Verify API"
// iframe that shows a connecting wallet this dApp is legitimate.
const WALLET_CONNECT_RELAY_HOSTS = "wss://relay.walletconnect.org wss://relay.walletconnect.com";
const WALLET_CONNECT_AUX_HOSTS =
  "https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com";
const WALLET_CONNECT_VERIFY_HOSTS = "https://verify.walletconnect.com https://verify.walletconnect.org";

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // The wallet kit's connect modal renders via twind (runtime CSS-in-JS),
    // which injects <style> tags with no nonce support — the one deliberate
    // exception here. script-src stays strict (no unsafe-inline, no unsafe-eval).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self' ${WALLET_CONNECT_RELAY_HOSTS} ${WALLET_CONNECT_AUX_HOSTS}`,
    `frame-src ${WALLET_CONNECT_VERIFY_HOSTS}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
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
    // Skip static assets, image optimization, and the JSON API routes (which
    // carry no HTML/inline scripts and don't need a nonce or CSP header).
    "/((?!_next/static|_next/image|favicon|api/).*)",
  ],
};
