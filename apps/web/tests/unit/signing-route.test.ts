import { expect, test } from "bun:test";
import { isSigningRoute } from "@/lib/utils/signing-route";

test("isSigningRoute › matches review, execute and complete on either network", () => {
  for (const path of ["/mainnet/review", "/testnet/execute", "/mainnet/complete/"]) {
    expect(isSigningRoute(path)).toBe(true);
  }
});

test("isSigningRoute › ignores the entry, analyze and allowances routes", () => {
  for (const path of ["/mainnet", "/testnet/analyze", "/mainnet/allowances", "/", ""]) {
    expect(isSigningRoute(path)).toBe(false);
  }
});
