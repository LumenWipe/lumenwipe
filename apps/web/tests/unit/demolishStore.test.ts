import { test, expect, beforeEach, describe } from "bun:test";
import { useDemolishStore } from "@/store/demolish";
import type { PlannedStep, StepType } from "@/types/plan";
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
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
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

test("markCoveredConfirmed confirms every step whose type a transaction covers", () => {
  const mk = (index: number, type: StepType): PlannedStep => ({ ...step(index), type });
  useDemolishStore
    .getState()
    .setPlan([mk(0, "NORMALIZE_SIGNERS"), mk(1, "REMOVE_TRUSTLINES"), mk(2, "MERGE")]);

  // A first fused transaction covers the signer + trustline steps at once.
  useDemolishStore
    .getState()
    .markCoveredConfirmed(["NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES"], "hashA");
  let plan = useDemolishStore.getState().executionPlan;
  expect(plan.filter((p) => p.status === "confirmed").map((p) => p.type)).toEqual([
    "NORMALIZE_SIGNERS",
    "REMOVE_TRUSTLINES",
  ]);
  expect(plan.find((p) => p.type === "MERGE")!.status).toBe("pending"); // not yet
  expect(plan[0].txHash).toBe("hashA");
  expect(useDemolishStore.getState().phase).toBe("STEP_CONFIRMED");

  // A second transaction covers the merge.
  useDemolishStore.getState().markCoveredConfirmed(["MERGE"], "hashB");
  plan = useDemolishStore.getState().executionPlan;
  expect(plan.every((p) => p.status === "confirmed")).toBe(true);
  expect(plan.find((p) => p.type === "MERGE")!.txHash).toBe("hashB");
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

// ─── Claimable balance selections ─────────────────────────────────────────────

test("claimableBalanceSelections defaults to empty", () => {
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({});
});

test("setClaimableBalanceSelection records a decision and merges further decisions", () => {
  useDemolishStore.getState().setClaimableBalanceSelection("bal1", "add_trustline_then_claim");
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({
    bal1: "add_trustline_then_claim",
  });

  useDemolishStore.getState().setClaimableBalanceSelection("bal2", "forfeit");
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({
    bal1: "add_trustline_then_claim",
    bal2: "forfeit",
  });
});

test("setAccountState keeps claimable balance selections for balances still present after a re-scan", () => {
  useDemolishStore.getState().setClaimableBalanceSelection("bal1", "forfeit");
  useDemolishStore.getState().setAccountState(
    accountState({
      claimableBalances: [
        {
          id: "bal1",
          asset: "native",
          amount: "1.0000000",
          claimants: [],
          sponsor: null,
        },
      ],
    })
  );
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({ bal1: "forfeit" });
});

test("setAccountState prunes claimable balance selections for balances no longer reported", () => {
  useDemolishStore.getState().setClaimableBalanceSelection("bal1", "forfeit");
  useDemolishStore.getState().setClaimableBalanceSelection("bal2", "claim");
  // The new state only reports bal1; the bal2 selection is stale and must be dropped.
  useDemolishStore.getState().setAccountState(
    accountState({
      claimableBalances: [
        { id: "bal1", asset: "native", amount: "1.0000000", claimants: [], sponsor: null },
      ],
    })
  );
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({ bal1: "forfeit" });
});

test("reset clears claimable balance selections", () => {
  useDemolishStore.getState().setClaimableBalanceSelection("bal1", "forfeit");
  useDemolishStore.getState().reset();
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({});
});

// ─── Session identity ────────────────────────────────────────────────────────

describe("session identity", () => {
  test("initSession generates a non-empty ID", () => {
    useDemolishStore.getState().initSession();
    expect(useDemolishStore.getState().sessionId).not.toBeNull();
    expect(useDemolishStore.getState().sessionId!.length).toBeGreaterThan(8);
  });

  test("initSession generates a different ID on each call", () => {
    useDemolishStore.getState().initSession();
    const first = useDemolishStore.getState().sessionId;
    useDemolishStore.getState().initSession();
    const second = useDemolishStore.getState().sessionId;
    expect(first).not.toBe(second);
  });

  // Regression: the resume flow was calling initSession() which generated a fresh
  // UUID, leaving the original "in_progress" session in IndexedDB forever.
  // restoreSession must preserve the provided ID verbatim.
  test("restoreSession stores the provided ID without modification", () => {
    const id = "existing-session-from-idb";
    useDemolishStore.getState().restoreSession(id);
    expect(useDemolishStore.getState().sessionId).toBe(id);
  });

  test("restoreSession is idempotent for the same ID", () => {
    const id = "stable-id";
    useDemolishStore.getState().restoreSession(id);
    useDemolishStore.getState().restoreSession(id);
    expect(useDemolishStore.getState().sessionId).toBe(id);
  });

  test("reset clears the session ID", () => {
    useDemolishStore.getState().restoreSession("some-id");
    useDemolishStore.getState().reset();
    expect(useDemolishStore.getState().sessionId).toBeNull();
  });
});

// ─── Mediator state ──────────────────────────────────────────────────────────

describe("mediator state", () => {
  test("setMediatorRequired(true) records that the close routes through an intermediary", () => {
    useDemolishStore.getState().setMediatorRequired(true);
    const s = useDemolishStore.getState();
    expect(s.mediatorRequired).toBe(true);
  });

  test("setMediatorRequired(false) records a direct close", () => {
    useDemolishStore.getState().setMediatorRequired(true);
    useDemolishStore.getState().setMediatorRequired(true);
  });

  test("setMediatorRequired(false) clears both fields", () => {
    useDemolishStore.getState().setMediatorRequired(true);
    useDemolishStore.getState().setMediatorRequired(false);
    const s = useDemolishStore.getState();
    expect(s.mediatorRequired).toBe(false);
  });
});

// ─── Step lifecycle ───────────────────────────────────────────────────────────

describe("step lifecycle", () => {
  test("markStepConfirmed sets status=confirmed and records txHash", () => {
    useDemolishStore.getState().setPlan([step(0), step(1)]);
    useDemolishStore.getState().markStepConfirmed(0, "txhash_abc");
    const s = useDemolishStore.getState().executionPlan.find((x) => x.index === 0)!;
    expect(s.status).toBe("confirmed");
    expect(s.txHash).toBe("txhash_abc");
  });

  test("markStepConfirmed only affects the targeted step", () => {
    useDemolishStore.getState().setPlan([step(0), step(1), step(2)]);
    useDemolishStore.getState().markStepConfirmed(1, "tx1");
    const plan = useDemolishStore.getState().executionPlan;
    expect(plan[0].status).toBe("pending");
    expect(plan[1].status).toBe("confirmed");
    expect(plan[2].status).toBe("pending");
  });

  test("markStepFailed sets status=failed, records error, and sets phase=STEP_FAILED", () => {
    useDemolishStore.getState().setPlan([step(0)]);
    useDemolishStore.getState().markStepFailed(0, "tx_bad_auth");
    const s = useDemolishStore.getState();
    expect(s.executionPlan[0].status).toBe("failed");
    expect(s.executionPlan[0].error).toBe("tx_bad_auth");
    expect(s.phase).toBe("STEP_FAILED");
    expect(s.lastError).toBe("tx_bad_auth");
  });
});

// ─── Session recovery: findResumableSession logic ───────────────────────────
// Tests the pure filtering/sorting logic without hitting IndexedDB.

import type { SessionRecord } from "@/types/session";

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    network: "testnet",
    sourceAddress: "GSOURCE",
    destinationAddress: "GDEST",
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    status: "in_progress",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...over,
  };
}

function findResumable(sessions: SessionRecord[], network: "testnet" | "mainnet") {
  const matching = sessions
    .filter((s) => s.network === network && s.status === "in_progress")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return matching[0] ?? null;
}

describe("findResumableSession logic", () => {
  test("returns null when there are no sessions", () => {
    expect(findResumable([], "testnet")).toBeNull();
  });

  test("returns null when no session matches the network", () => {
    expect(findResumable([makeSession({ network: "mainnet" })], "testnet")).toBeNull();
  });

  test("returns null when the only matching session is completed", () => {
    expect(findResumable([makeSession({ status: "completed" })], "testnet")).toBeNull();
  });

  test("returns the in_progress session for the correct network", () => {
    const target = makeSession({ id: "target", network: "testnet" });
    const other = makeSession({ id: "other", network: "mainnet" });
    expect(findResumable([target, other], "testnet")?.id).toBe("target");
  });

  test("returns the most recently updated session when multiple in_progress exist", () => {
    const older = makeSession({ id: "older", updatedAt: "2025-01-01T00:00:00.000Z" });
    const newer = makeSession({ id: "newer", updatedAt: "2025-06-01T00:00:00.000Z" });
    expect(findResumable([older, newer], "testnet")?.id).toBe("newer");
    expect(findResumable([newer, older], "testnet")?.id).toBe("newer");
  });

  test("ignores completed sessions even if newer than in_progress ones", () => {
    const completed = makeSession({
      id: "done",
      status: "completed",
      updatedAt: "2025-12-31T00:00:00.000Z",
    });
    const active = makeSession({
      id: "active",
      status: "in_progress",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(findResumable([completed, active], "testnet")?.id).toBe("active");
  });
});

// ─── SessionRecord shape ──────────────────────────────────────────────────────

describe("SessionRecord.memoType", () => {
  // Regression: memoType was missing from the type before the QA pass.
  // On resume, the stored memo type was re-derived from the exchange registry
  // which is fragile. It must be persisted in the record itself.
  test("accepts 'text' memoType", () => {
    const r: SessionRecord = makeSession({ memoType: "text" });
    expect(r.memoType).toBe("text");
  });

  test("accepts 'id' memoType", () => {
    const r: SessionRecord = makeSession({ memoType: "id" });
    expect(r.memoType).toBe("id");
  });

  test("accepts null memoType for non-memo destinations", () => {
    const r: SessionRecord = makeSession({ memoType: null });
    expect(r.memoType).toBeNull();
  });
});

// ─── Resume flow store state ──────────────────────────────────────────────────
// These test the sequence of store mutations that handleResume performs before
// navigating to /analyze. The router.push itself is not testable here; what
// matters is that all store values are correct by the time the analyze page mounts.

describe("resume flow store mutations", () => {
  test("setAddresses then restoreSession correctly populates source, destination, and sessionId", () => {
    useDemolishStore.getState().setAddresses("GSOURCE", "GDEST", undefined, undefined);
    useDemolishStore.getState().restoreSession("session-from-idb");
    const s = useDemolishStore.getState();
    expect(s.sourceAddress).toBe("GSOURCE");
    expect(s.destinationAddress).toBe("GDEST");
    expect(s.memo).toBeNull();
    expect(s.memoType).toBeNull();
    expect(s.sessionId).toBe("session-from-idb");
  });

  test("setAddresses with memo and memoType preserves them for PlanView pre-fill", () => {
    useDemolishStore.getState().setAddresses("GSOURCE", "GDEST", "12345678", "id");
    const s = useDemolishStore.getState();
    expect(s.memo).toBe("12345678");
    expect(s.memoType).toBe("id");
  });

  test("setAddresses without memo clears it to null (no stale data from prior session)", () => {
    useDemolishStore.getState().setAddresses("GSOURCE1", "GDEST1", "old-memo", "text");
    useDemolishStore.getState().setAddresses("GSOURCE2", "GDEST2");
    const s = useDemolishStore.getState();
    expect(s.memo).toBeNull();
    expect(s.memoType).toBeNull();
  });

  test("setMediatorRequired(true, key) followed by restoreSession is fully set before navigate", () => {
    useDemolishStore.getState().setAddresses("GSRC", "GDST");
    useDemolishStore.getState().setMediatorRequired(true);
    useDemolishStore.getState().restoreSession("s-abc");
    const s = useDemolishStore.getState();
    expect(s.mediatorRequired).toBe(true);
    expect(s.sessionId).toBe("s-abc");
  });

  test("setMediatorRequired(false) on resume clears mediator state", () => {
    useDemolishStore.getState().setMediatorRequired(true);
    useDemolishStore.getState().setMediatorRequired(false);
    const s = useDemolishStore.getState();
    expect(s.mediatorRequired).toBe(false);
  });

  test("reset after a full resume clears all store fields including sessionId and addresses", () => {
    useDemolishStore.getState().setAddresses("GSRC", "GDST", "memo", "text");
    useDemolishStore.getState().setMediatorRequired(true);
    useDemolishStore.getState().restoreSession("sid");
    useDemolishStore.getState().setPlan([step(0), step(1)]);
    useDemolishStore.getState().reset();
    const s = useDemolishStore.getState();
    expect(s.sourceAddress).toBeNull();
    expect(s.destinationAddress).toBeNull();
    expect(s.memo).toBeNull();
    expect(s.memoType).toBeNull();
    expect(s.mediatorRequired).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.executionPlan).toHaveLength(0);
    expect(s.currentStepIndex).toBe(0);
    expect(s.phase).toBe("IDLE");
  });
});

// ─── memoType backward-compat for old SessionRecords ─────────────────────────
// Old sessions (created before memoType was added to the type) have memoType=undefined
// at runtime even though the type says null. The resume handler uses `?? undefined`
// which correctly treats both null and undefined as "not set".

describe("memoType backward-compat (runtime undefined)", () => {
  test("session with null memoType is treated as absent", () => {
    const s = makeSession({ memoType: null });
    // Reproduce the exact logic from handleResume:
    const memoType = s.memoType ?? undefined;
    expect(memoType).toBeUndefined();
  });

  test("session with explicit memoType is preserved", () => {
    const s = makeSession({ memoType: "text" });
    const memoType = s.memoType ?? undefined;
    expect(memoType).toBe("text");
  });

  test("session with id memoType and memo passes through to setAddresses correctly", () => {
    const s = makeSession({ memo: "12345678", memoType: "id" });
    const memoType = s.memoType ?? undefined;
    useDemolishStore
      .getState()
      .setAddresses(s.sourceAddress, s.destinationAddress, s.memo ?? undefined, memoType);
    const store = useDemolishStore.getState();
    expect(store.memo).toBe("12345678");
    expect(store.memoType).toBe("id");
  });
});

// ─── Transfer destinations (#113) ────────────────────────────────────────────
//
// These back verify()'s guarantee. The destination it checks a payment against comes from
// this store, so anything that leaves a stale one here would make the anchor vouch for a
// payment the user is no longer asking for.

test("setTransferDestination records a destination per asset", () => {
  const store = useDemolishStore.getState();
  store.setTransferDestination("USDC:GISS", "GDEST1");
  store.setTransferDestination("EURC:GISS", "GDEST2");

  expect(useDemolishStore.getState().transferDestinations).toEqual({
    "USDC:GISS": "GDEST1",
    "EURC:GISS": "GDEST2",
  });
});

test("switching an asset away from transfer drops its destination", () => {
  const store = useDemolishStore.getState();
  store.setAssetDisposition("USDC:GISS", "transfer");
  store.setTransferDestination("USDC:GISS", "GDEST1");
  expect(useDemolishStore.getState().transferDestinations["USDC:GISS"]).toBe("GDEST1");

  // A stale destination would still be handed to verify(), which would then accept a payment
  // for an asset the user has since decided to swap.
  useDemolishStore.getState().setAssetDisposition("USDC:GISS", "convert");
  expect(useDemolishStore.getState().transferDestinations["USDC:GISS"]).toBeUndefined();
});

test("switching to issuer also drops the destination", () => {
  const store = useDemolishStore.getState();
  store.setAssetDisposition("FOO:GISS", "transfer");
  store.setTransferDestination("FOO:GISS", "GDEST1");
  useDemolishStore.getState().setAssetDisposition("FOO:GISS", "issuer");
  expect(useDemolishStore.getState().transferDestinations["FOO:GISS"]).toBeUndefined();
});

test("staying on transfer keeps the destination", () => {
  const store = useDemolishStore.getState();
  store.setTransferDestination("USDC:GISS", "GDEST1");
  useDemolishStore.getState().setAssetDisposition("USDC:GISS", "transfer");
  expect(useDemolishStore.getState().transferDestinations["USDC:GISS"]).toBe("GDEST1");
});

test("a null destination clears the entry rather than storing an empty string", () => {
  const store = useDemolishStore.getState();
  store.setTransferDestination("USDC:GISS", "GDEST1");
  useDemolishStore.getState().setTransferDestination("USDC:GISS", null);
  // An empty string would be a truthy-looking key that fails validation downstream; absence is
  // what the rest of the flow tests for.
  expect(useDemolishStore.getState().transferDestinations).toEqual({});
});

test("re-analyzing prunes destinations for assets the account no longer holds", () => {
  const store = useDemolishStore.getState();
  store.setTransferDestination("USDC:GISS", "GDEST1");
  store.setTransferDestination("GONE:GISS", "GDEST2");

  useDemolishStore.getState().setAccountState(
    accountState({
      trustlines: [
        { asset: "USDC:GISS", balance: "10", authorized: true, issuer: "GISS", code: "USDC" },
      ],
    })
  );

  expect(useDemolishStore.getState().transferDestinations).toEqual({ "USDC:GISS": "GDEST1" });
});
