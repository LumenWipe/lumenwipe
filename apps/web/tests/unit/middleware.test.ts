import { test, expect } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function cspFor(url = "https://www.lumenwipe.com/"): string {
  const response = middleware(new NextRequest(url));
  const csp = response.headers.get("Content-Security-Policy");
  if (!csp) throw new Error("middleware did not set a Content-Security-Policy header");
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
