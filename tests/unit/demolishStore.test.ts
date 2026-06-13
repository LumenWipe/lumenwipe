import { test, expect, beforeEach } from "bun:test";
import { useDemolishStore } from "@/store/demolish";
import type { PlannedStep } from "@/types/plan";
import type { AccountState, Trustline } from "@/types/account";

function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: "GSOURCE",
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    ...over,
  };
}

function trustline(asset: string): Trustline {
  const [code, issuer] = asset.split(":");
  return { asset, balance: "10.0000000", limit: "1", authorized: true, issuer, code };
}

function step(index: number): PlannedStep {
  return {
    index,
    type: "MERGE",
    title: "Merge account",
    description: "Merge this account.",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

beforeEach(() => {
  useDemolishStore.getState().reset();
});

// Regression: a prior run left currentStepIndex advanced; starting a new, shorter
// plan (e.g. the single-step fast-path CLOSE_ACCOUNT) left the pointer out of
// range, so executionPlan[currentStepIndex] was undefined and the execute screen
// showed "No execution plan found". setPlan must reset the pointer to 0.
test("setPlan resets currentStepIndex so a new shorter plan is in range", () => {
  // Simulate a previous demolition that advanced the step pointer.
  useDemolishStore.getState().setCurrentStepIndex(9);
  expect(useDemolishStore.getState().currentStepIndex).toBe(9);

  // Begin a new single-step plan (the fused fast-path close).
  useDemolishStore.getState().setPlan([step(0)]);

  const s = useDemolishStore.getState();
  expect(s.currentStepIndex).toBe(0);
  expect(s.executionPlan).toHaveLength(1);
  // The current step must resolve - this is exactly what was undefined before.
  expect(s.executionPlan[s.currentStepIndex]).toBeDefined();
});

test("setPlan stores the provided plan", () => {
  useDemolishStore.getState().setPlan([step(0), step(1)]);
  expect(useDemolishStore.getState().executionPlan.map((s) => s.index)).toEqual([0, 1]);
});

test("assetDispositions defaults to empty", () => {
  expect(useDemolishStore.getState().assetDispositions).toEqual({});
});

test("setAssetDisposition records a decision and merges further decisions", () => {
  useDemolishStore.getState().setAssetDisposition("USDC:GISSUER", "issuer");
  expect(useDemolishStore.getState().assetDispositions).toEqual({ "USDC:GISSUER": "issuer" });

  useDemolishStore.getState().setAssetDisposition("EURC:GOTHER", "convert");
  expect(useDemolishStore.getState().assetDispositions).toEqual({
    "USDC:GISSUER": "issuer",
    "EURC:GOTHER": "convert",
  });
});

// Regression: the analyze-page refresh button re-runs the account fetch, which
// calls setAccountState. The old behavior wiped ALL dispositions, dropping a
// user's "return to issuer" decision; the fused close then re-quoted that asset
// and failed with a lost route. A re-scan of the SAME asset must keep the choice.
test("setAccountState keeps dispositions for assets still present after a re-scan", () => {
  useDemolishStore.getState().setAssetDisposition("NOSWAP:GISSUER", "issuer");
  useDemolishStore
    .getState()
    .setAccountState(accountState({ trustlines: [trustline("NOSWAP:GISSUER")] }));
  expect(useDemolishStore.getState().assetDispositions).toEqual({ "NOSWAP:GISSUER": "issuer" });
});

test("setAccountState prunes dispositions for assets no longer held", () => {
  useDemolishStore.getState().setAssetDisposition("USDC:GISSUER", "issuer");
  useDemolishStore.getState().setAssetDisposition("EURC:GOTHER", "convert");
  // The new state only holds USDC; the EURC decision is stale and must be dropped.
  useDemolishStore
    .getState()
    .setAccountState(accountState({ trustlines: [trustline("USDC:GISSUER")] }));
  expect(useDemolishStore.getState().assetDispositions).toEqual({ "USDC:GISSUER": "issuer" });
});

test("reset clears asset dispositions", () => {
  useDemolishStore.getState().setAssetDisposition("USDC:GISSUER", "issuer");
  useDemolishStore.getState().reset();
  expect(useDemolishStore.getState().assetDispositions).toEqual({});
});
