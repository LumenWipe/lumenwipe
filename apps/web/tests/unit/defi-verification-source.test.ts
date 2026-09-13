import { test, expect } from "bun:test";
import { defiVerificationLabel } from "@/lib/plan/defi-verification-source";

// Mirrors resolve-defi-positions.ts's source vocabulary (apps/api) - kept as plain string
// literals here rather than an import, same boundary resolvable-blockers.ts already crosses
// with blocker codes: the web never imports the API's closing/detection modules.

test("a real OctoPos snapshot is labeled octopos", () => {
  expect(defiVerificationLabel("snapshot")).toBe("octopos");
});

test("OctoPos's own empty and cache sources are labeled octopos too", () => {
  expect(defiVerificationLabel("empty")).toBe("octopos");
  expect(defiVerificationLabel("cache")).toBe("octopos");
});

test("a confirmed-empty direct read is labeled lumenwipe", () => {
  expect(defiVerificationLabel("octopos-degraded-direct-read-confirmed-empty")).toBe("lumenwipe");
});

test("testnet's own direct-read path is labeled lumenwipe", () => {
  expect(defiVerificationLabel("testnet-direct-read")).toBe("lumenwipe");
});

// A totally unconfirmed degraded result (both OctoPos and the direct read failed) already
// surfaces as a hard blocker - nothing was actually verified, so it gets no label at all rather
// than a misleading "verified by" claim.
test("a totally unconfirmed degraded result gets no label", () => {
  expect(defiVerificationLabel("octopos-degraded-fallback")).toBeNull();
});

test("an unrecognized source gets no label", () => {
  expect(defiVerificationLabel("not-tracked")).toBeNull();
  expect(defiVerificationLabel("")).toBeNull();
});
