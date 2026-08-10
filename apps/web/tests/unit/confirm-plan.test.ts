import { test, expect } from "bun:test";
import { goToReview, goBackToAnalyze } from "@/lib/plan/confirm-plan";
import type { DemolishPhase } from "@/types/plan";
import type { Network } from "@/config/networks";

function fakeSetPhase(): { calls: DemolishPhase[]; setPhase: (phase: DemolishPhase) => void } {
  const calls: DemolishPhase[] = [];
  return { calls, setPhase: (phase) => calls.push(phase) };
}

function fakeNav(): { pushed: string[]; push: (path: string) => void } {
  const pushed: string[] = [];
  return { pushed, push: (path) => pushed.push(path) };
}

test("goToReview sets phase to PREFLIGHT_COMPLETE, never STEP_EXECUTING", () => {
  const { calls, setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goToReview(setPhase, nav, "testnet");

  expect(calls).toEqual(["PREFLIGHT_COMPLETE"]);
  expect(calls).not.toContain("STEP_EXECUTING");
});

test("goToReview navigates to /review, never directly to /execute", () => {
  const { setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goToReview(setPhase, nav, "testnet");

  expect(nav.pushed).toEqual(["/testnet/review"]);
  expect(nav.pushed.some((p) => p.includes("/execute"))).toBe(false);
});

test.each<Network>(["testnet", "mainnet"])("goToReview targets /%s/review", (network) => {
  const { setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goToReview(setPhase, nav, network);

  expect(nav.pushed).toEqual([`/${network}/review`]);
});

test("goBackToAnalyze sets phase to PREFLIGHT_COMPLETE, never past it", () => {
  const { calls, setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goBackToAnalyze(setPhase, nav, "testnet");

  expect(calls).toEqual(["PREFLIGHT_COMPLETE"]);
  expect(calls).not.toContain("STEP_EXECUTING");
});

test("goBackToAnalyze navigates to /analyze, never to /execute", () => {
  const { setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goBackToAnalyze(setPhase, nav, "testnet");

  expect(nav.pushed).toEqual(["/testnet/analyze"]);
  expect(nav.pushed.some((p) => p.includes("/execute"))).toBe(false);
});

test.each<Network>(["testnet", "mainnet"])("goBackToAnalyze targets /%s/analyze", (network) => {
  const { setPhase } = fakeSetPhase();
  const nav = fakeNav();

  goBackToAnalyze(setPhase, nav, network);

  expect(nav.pushed).toEqual([`/${network}/analyze`]);
});
