import { describe, expect, test } from "bun:test";
import { confirmedStepCount, receiptState, submissionClaim } from "@/lib/close-state";
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

describe("receiptState", () => {
  test("closed when the merge step is confirmed", () => {
    expect(
      receiptState([step(0, "REMOVE_DATA_ENTRIES", "confirmed"), step(1, "MERGE", "confirmed")])
    ).toBe("closed");
  });

  test("closed when a fused CLOSE_ACCOUNT step is confirmed alone", () => {
    expect(receiptState([step(0, "CLOSE_ACCOUNT", "confirmed")])).toBe("closed");
  });

  test("incomplete when only non-merge steps are confirmed", () => {
    expect(receiptState([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")])).toBe(
      "incomplete"
    );
  });

  test("incomplete when the merge step is confirmed without a hash", () => {
    const merge = { ...step(0, "MERGE", "confirmed"), txHash: null };
    expect(receiptState([merge])).toBe("incomplete");
  });

  test("incomplete for an empty plan", () => {
    expect(receiptState([])).toBe("incomplete");
  });
});

describe("submissionClaim", () => {
  const unconfirmed = [step(0, "MERGE", "pending")];
  const confirmed = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")];
  const early: DemolishPhase[] = ["IDLE", "ANALYZING", "PREFLIGHT_COMPLETE"];
  const later: DemolishPhase[] = [
    "SIGNER_SETUP",
    "STEP_EXECUTING",
    "STEP_CONFIRMED",
    "STEP_FAILED",
    "COMPLETE",
    "ABORTED",
  ];

  test.each(early)("%s with nothing confirmed claims nothing was sent", (phase) => {
    expect(submissionClaim(phase, unconfirmed)).toBe("nothing-sent");
  });

  test.each(early)("%s with a confirmed step may have sent", (phase) => {
    expect(submissionClaim(phase, confirmed)).toBe("may-be-sent");
  });

  test.each(later)("%s may have sent", (phase) => {
    expect(submissionClaim(phase, unconfirmed)).toBe("may-be-sent");
  });

  test("counts confirmed steps", () => {
    expect(confirmedStepCount(confirmed)).toBe(1);
  });
});
