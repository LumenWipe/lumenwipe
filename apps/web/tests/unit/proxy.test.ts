import { test, expect } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
// Generated once from origin/main at 9a13771c, before the marketing pages left the proxy (#535): the
// policy proxy.ts returned for each path, its nonce replaced with NONCE. Never regenerate it from
// a later proxy: it is what keeps the app and sign-in policy byte for byte unchanged. One
// deliberate edit since: https://gateway.umami.is was removed from each connect-src (#1001).
import NONCE_POLICY from "./fixtures/nonce-csp-golden.json";

function cspFor(url = "https://www.lumenwipe.com/"): string {
  const response = proxy(new NextRequest(url));
  const csp = response.headers.get("Content-Security-Policy");
  if (!csp) throw new Error("proxy did not set a Content-Security-Policy header");
  return csp;
}

test("connect-src allows no analytics host", () => {
  expect(cspFor()).not.toContain("umami");
});

test("connect-src still allows every WalletConnect host it always has", () => {
  const csp = cspFor();
  for (const host of [
    "wss://relay.walletconnect.org",
    "wss://relay.walletconnect.com",
    "https://pulse.walletconnect.org",
    "https://api.web3modal.org",
    "https://explorer-api.walletconnect.com",
  ]) {
    expect(csp).toContain(host);
  }
});

test("the page CSP is the strict nonce policy, with only report-to added", () => {
  const csp = cspFor();
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  if (!nonce) throw new Error("the CSP has no nonce");
  expect(csp.replace(nonce, "NONCE")).toBe(
    [
      "default-src 'self'",
      "script-src 'self' 'nonce-NONCE' 'strict-dynamic'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' wss://relay.walletconnect.org wss://relay.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com https://sdk.api.pollar.xyz https://server.api.pollar.xyz",
      "frame-src https://verify.walletconnect.com https://verify.walletconnect.org https://www.youtube-nocookie.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
      "report-to csp",
    ].join("; ")
  );
});

test("the network, sign-in and 404 paths keep the nonce policy byte for byte", () => {
  for (const [path, golden] of Object.entries(NONCE_POLICY)) {
    const csp = cspFor(`https://www.lumenwipe.com${path}`);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce, path).toBeTruthy();
    expect(csp.replace(`'nonce-${nonce}'`, "'nonce-NONCE'"), path).toBe(golden);
  }
});

/** The locale header proxy.ts forwards to the page for `url`, sent with `inbound` if given. */
function forwardedLocale(url: string, inbound?: string): string | null {
  const headers = inbound ? { "x-lumenwipe-locale": inbound } : undefined;
  const response = proxy(new NextRequest(url, { headers }));
  return response.headers.get("x-middleware-request-x-lumenwipe-locale");
}

test("the locale header names Spanish for /es and every path under it, English for the rest", () => {
  const cases: [string, string][] = [
    ["/es", "es"],
    ["/es/nope", "es"],
    ["/es/x/y/z", "es"],
    ["/esx", "en"],
    ["/ES/nope", "en"],
    ["/nope", "en"],
    ["/", "en"],
    ["/mainnet/nope", "en"],
    ["/api/health", "en"],
  ];
  for (const [path, locale] of cases) {
    expect(forwardedLocale(`https://www.lumenwipe.com${path}`), path).toBe(locale);
  }
});

test("the locale header always overwrites the value a client sent", () => {
  expect(forwardedLocale("https://www.lumenwipe.com/nope", "es")).toBe("en");
  expect(forwardedLocale("https://www.lumenwipe.com/es/nope", "en")).toBe("es");
  expect(forwardedLocale("https://www.lumenwipe.com/nope", "<script>")).toBe("en");
});
