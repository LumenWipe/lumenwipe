import { test, expect, beforeEach } from "bun:test";
import { useDemolishStore } from "@/store/demolish";
import type { PlannedStep } from "@/types/plan";

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
