import type { DemolishPhase, PlannedStep } from "@/types/plan";

/** Where the person is in a close, as far as this browser can tell. */
export type JourneyStateName =
  "untouched" | "planned" | "reviewed" | "signing" | "partial" | "complete" | "unknown";

export interface JourneyInput {
  phase: DemolishPhase;
  plan: readonly PlannedStep[];
  /** A transaction of this close has an outcome nobody has settled yet. */
  inFlight: boolean;
  /** A resumable record of this close is saved, so an earlier run may have sent transactions
   *  the plan in hand knows nothing about. */
  saved: boolean;
}

export interface Journey {
  state: JourneyStateName;
  confirmed: number;
  total: number;
  mergeConfirmed: boolean;
  mayBeInFlight: boolean;
  /** Why the close stopped, while it is stopped on the execute page. */
  halted: "failed" | "unconfirmed" | null;
}

type PhaseStage = "before-review" | "reviewed" | "signing";

// The reserved SIGNER_SETUP and ABORTED phases are taken as past the review: neither can promise
// that nothing was sent.
const PHASE_STAGE: Record<DemolishPhase, PhaseStage> = {
  IDLE: "before-review",
  ANALYZING: "before-review",
  SIGNER_SETUP: "signing",
  ABORTED: "signing",
  PREFLIGHT_COMPLETE: "reviewed",
  STEP_EXECUTING: "signing",
  STEP_CONFIRMED: "signing",
  STEP_FAILED: "signing",
  STEP_UNCONFIRMED: "signing",
  COMPLETE: "signing",
};

const HALTED: Partial<Record<DemolishPhase, Journey["halted"]>> = {
  STEP_FAILED: "failed",
  STEP_UNCONFIRMED: "unconfirmed",
};

function stateOf(input: JourneyInput, facts: Omit<Journey, "state" | "halted">): JourneyStateName {
  if (facts.mergeConfirmed) return "complete";
  if (facts.confirmed > 0) return "partial";
  const stage = PHASE_STAGE[input.phase];
  if (stage === "signing") return "signing";
  if (input.saved) return "unknown";
  if (facts.mayBeInFlight) return "signing";
  if (stage === "reviewed") return "reviewed";
  return input.plan.length > 0 ? "planned" : "untouched";
}

/** The person's position in a close, read only from what is confirmed, what may be in flight and
 *  what was saved: a phase alone never makes a close complete, and never makes it untouched once
 *  a record of an earlier run exists. */
export function deriveJourneyState(input: JourneyInput): Journey {
  const confirmed = input.plan.filter((s) => s.status === "confirmed").length;
  const mergeConfirmed = input.plan.some(
    (s) =>
      (s.type === "MERGE" || s.type === "CLOSE_ACCOUNT") && s.status === "confirmed" && !!s.txHash
  );
  const facts = {
    confirmed,
    total: input.plan.length,
    mergeConfirmed,
    mayBeInFlight: input.inFlight || input.phase === "STEP_UNCONFIRMED",
  };
  return { ...facts, state: stateOf(input, facts), halted: HALTED[input.phase] ?? null };
}

export interface JourneyStore {
  phase: DemolishPhase;
  executionPlan: readonly PlannedStep[];
  unconfirmedSubmission: unknown;
  sessionId: string | null;
}

/** The journey of the close the store holds. A session id is only ever set by saving the close on
 *  confirm or by resuming a saved one. */
export function journeyOf(store: JourneyStore): Journey {
  return deriveJourneyState({
    phase: store.phase,
    plan: store.executionPlan,
    inFlight: store.unconfirmedSubmission !== null,
    saved: store.sessionId !== null,
  });
}
