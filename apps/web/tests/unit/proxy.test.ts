import { test, expect } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function cspFor(url = "https://www.lumenwipe.com/"): string {
  const response = proxy(new NextRequest(url));
  const csp = response.headers.get("Content-Security-Policy");
  if (!csp) throw new Error("proxy did not set a Content-Security-Policy header");
  return csp;
}

test("connect-src allows Umami's collection gateway, so the analytics beacon isn't blocked", () => {
  expect(cspFor()).toContain("https://gateway.umami.is");
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
      "connect-src 'self' wss://relay.walletconnect.org wss://relay.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com https://gateway.umami.is https://sdk.api.pollar.xyz https://server.api.pollar.xyz",
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
