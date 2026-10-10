import type { DemolishPhase, PlannedStep } from "@/types/plan";

export type ReceiptState = "closed" | "incomplete";
export type SubmissionClaim = "nothing-sent" | "may-be-sent";

const PRE_SIGNING_PHASES: readonly DemolishPhase[] = ["IDLE", "ANALYZING", "PREFLIGHT_COMPLETE"];

export function confirmedStepCount(plan: readonly PlannedStep[]): number {
  return plan.filter((s) => s.status === "confirmed").length;
}

export function receiptState(plan: readonly PlannedStep[]): ReceiptState {
  const closed = plan.some(
    (s) =>
      (s.type === "MERGE" || s.type === "CLOSE_ACCOUNT") && s.status === "confirmed" && !!s.txHash
  );
  return closed ? "closed" : "incomplete";
}

export function submissionClaim(
  phase: DemolishPhase,
  plan: readonly PlannedStep[]
): SubmissionClaim {
  return PRE_SIGNING_PHASES.includes(phase) && confirmedStepCount(plan) === 0
    ? "nothing-sent"
    : "may-be-sent";
}
