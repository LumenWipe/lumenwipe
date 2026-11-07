import { describe, expect, test } from "bun:test";
import { deriveJourneyState, journeyOf, type JourneyStateName } from "@/lib/journey/journey-state";
import { ALLOWED_CLAIMS, allows, permittedClaims, type ClaimKey } from "@/lib/journey/claims";
import type { DemolishPhase, PlannedStep, StepStatus, StepType } from "@/types/plan";

function step(index: number, type: StepType, status: StepStatus): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
  };
}

const PHASES: DemolishPhase[] = [
  "IDLE",
  "ANALYZING",
  "PREFLIGHT_COMPLETE",
  "SIGNER_SETUP",
  "STEP_EXECUTING",
  "STEP_CONFIRMED",
  "STEP_FAILED",
  "STEP_UNCONFIRMED",
  "COMPLETE",
  "ABORTED",
];

const PLANS = {
  none: [],
  pending: [step(0, "CANCEL_OFFERS", "pending"), step(1, "MERGE", "pending")],
  someConfirmed: [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "failed")],
  mergeConfirmed: [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "confirmed")],
} satisfies Record<string, PlannedStep[]>;

type PlanKind = keyof typeof PLANS;

// With nothing confirmed, by phase, keyed by plan present / in flight / saved (1 = yes).
const BEFORE_REVIEW: Record<string, JourneyStateName> = {
  "000": "untouched",
  "100": "planned",
  "010": "signing",
  "110": "signing",
  "001": "unknown",
  "101": "unknown",
  "011": "unknown",
  "111": "unknown",
};
const REVIEWED: Record<string, JourneyStateName> = {
  ...BEFORE_REVIEW,
  "000": "reviewed",
  "100": "reviewed",
};
const UNCONFIRMED_STATE: Record<DemolishPhase, Record<string, JourneyStateName> | "signing"> = {
  IDLE: BEFORE_REVIEW,
  ANALYZING: BEFORE_REVIEW,
  PREFLIGHT_COMPLETE: REVIEWED,
  SIGNER_SETUP: "signing",
  ABORTED: "signing",
  STEP_EXECUTING: "signing",
  STEP_CONFIRMED: "signing",
  STEP_FAILED: "signing",
  STEP_UNCONFIRMED: "signing",
  COMPLETE: "signing",
};

function expectedState(
  phase: DemolishPhase,
  plan: PlanKind,
  inFlight: boolean,
  saved: boolean
): JourneyStateName {
  if (plan === "mergeConfirmed") return "complete";
  if (plan === "someConfirmed") return "partial";
  const table = UNCONFIRMED_STATE[phase];
  if (table === "signing") return "signing";
  return table[`${plan === "none" ? 0 : 1}${inFlight ? 1 : 0}${saved ? 1 : 0}`]!;
}

const COMBINATIONS = PHASES.flatMap((phase) =>
  (Object.keys(PLANS) as PlanKind[]).flatMap((plan) =>
    [false, true].flatMap((inFlight) =>
      [false, true].map((saved) => ({ phase, plan, inFlight, saved }))
    )
  )
);

const IN_FLIGHT_FALSE: ClaimKey[] = [
  "nothing-sent",
  "account-unchanged",
  "no-new-sent",
  "safe-to-retry",
  "sent-only-when-signed",
];

describe("deriveJourneyState", () => {
  test.each(COMBINATIONS)("%o", ({ phase, plan, inFlight, saved }) => {
    const journey = deriveJourneyState({ phase, plan: PLANS[plan], inFlight, saved });
    expect(journey).toEqual({
      state: expectedState(phase, plan, inFlight, saved),
      confirmed: { none: 0, pending: 0, someConfirmed: 1, mergeConfirmed: 2 }[plan],
      total: PLANS[plan].length,
      mergeConfirmed: plan === "mergeConfirmed",
      mayBeInFlight: inFlight || phase === "STEP_UNCONFIRMED",
      halted:
        phase === "STEP_FAILED" ? "failed" : phase === "STEP_UNCONFIRMED" ? "unconfirmed" : null,
    });
  });

  test("a merge confirmed without a hash does not close the account", () => {
    const merge = { ...step(0, "MERGE", "confirmed"), txHash: null };
    const journey = deriveJourneyState({
      phase: "COMPLETE",
      plan: [merge],
      inFlight: false,
      saved: true,
    });
    expect(journey.mergeConfirmed).toBe(false);
    expect(journey.state).toBe("partial");
  });

  test("a fused CLOSE_ACCOUNT step confirmed alone closes the account", () => {
    const plan = [step(0, "CLOSE_ACCOUNT", "confirmed")];
    expect(
      deriveJourneyState({ phase: "COMPLETE", plan, inFlight: false, saved: true }).state
    ).toBe("complete");
  });

  test("the store's journey reads a saved session id and an unsettled submission", () => {
    const base = { phase: "IDLE" as const, executionPlan: [], sessionId: null };
    expect(journeyOf({ ...base, unconfirmedSubmission: null }).state).toBe("untouched");
    expect(journeyOf({ ...base, unconfirmedSubmission: null, sessionId: "s" }).state).toBe(
      "unknown"
    );
    expect(journeyOf({ ...base, unconfirmedSubmission: { hash: "h" } }).mayBeInFlight).toBe(true);
  });
});

describe("allowance table", () => {
  const EXACT: Record<JourneyStateName, ClaimKey[]> = {
    untouched: [
      "key-stays-in-browser",
      "nothing-sent",
      "account-unchanged",
      "each-tx-checked",
      "sent-only-when-signed",
    ],
    planned: [
      "key-stays-in-browser",
      "nothing-sent",
      "account-unchanged",
      "each-tx-checked",
      "sent-only-when-signed",
    ],
    reviewed: [
      "key-stays-in-browser",
      "nothing-sent",
      "account-unchanged",
      "each-tx-checked",
      "confirm-not-started",
      "sent-only-when-signed",
      "more-sent-only-when-signed",
      "resume-after-stop",
    ],
    signing: [
      "key-stays-in-browser",
      "more-sent-only-when-signed",
      "resume-after-stop",
      "each-tx-checked",
      "this-tx-not-sent",
      "no-new-sent",
      "may-be-sent",
      "safe-to-retry",
      "can-resume",
      "recorded-progress",
    ],
    partial: [
      "key-stays-in-browser",
      "each-tx-checked",
      "this-tx-not-sent",
      "no-new-sent",
      "may-be-sent",
      "safe-to-retry",
      "still-open",
      "can-resume",
      "recorded-progress",
    ],
    complete: [
      "key-stays-in-browser",
      "each-tx-checked",
      "account-closed",
      "no-new-sent",
      "may-be-sent",
    ],
    unknown: [
      "key-stays-in-browser",
      "each-tx-checked",
      "more-sent-only-when-signed",
      "resume-after-stop",
      "confirm-not-started",
      "may-be-sent",
      "can-resume",
      "recorded-progress",
    ],
  };

  test.each(Object.keys(EXACT) as JourneyStateName[])("%s permits exactly its claims", (state) => {
    expect([...ALLOWED_CLAIMS[state]].sort()).toEqual([...EXACT[state]].sort());
  });

  test("signing never permits saying nothing was sent", () => {
    expect(ALLOWED_CLAIMS.signing).not.toContain("nothing-sent");
  });

  test.each(COMBINATIONS)("in flight removes what may still change: %o", (combination) => {
    const { phase, plan, inFlight, saved } = combination;
    const journey = deriveJourneyState({ phase, plan: PLANS[plan], inFlight, saved });
    const permitted = permittedClaims(journey);
    if (!journey.mayBeInFlight) {
      expect([...permitted].sort()).toEqual([...ALLOWED_CLAIMS[journey.state]].sort());
      return;
    }
    for (const claim of IN_FLIGHT_FALSE) expect(allows(journey, claim)).toBe(false);
  });

  test("an unknown close with a transaction in flight is never safe to retry", () => {
    const journey = deriveJourneyState({ phase: "IDLE", plan: [], inFlight: true, saved: true });
    expect(journey.state).toBe("unknown");
    expect(allows(journey, "safe-to-retry")).toBe(false);
    expect(allows({ ...journey, state: "partial" }, "safe-to-retry")).toBe(false);
  });

  test.each(Object.keys(EXACT) as JourneyStateName[])(
    "%s in flight still drops every in-flight claim",
    (state) => {
      const journey = {
        state,
        confirmed: 0,
        total: 0,
        mergeConfirmed: false,
        mayBeInFlight: true,
        halted: null,
      };
      for (const claim of IN_FLIGHT_FALSE) expect(allows(journey, claim)).toBe(false);
    }
  );
});
