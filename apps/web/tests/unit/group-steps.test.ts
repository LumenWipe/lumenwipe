import { test, expect } from "bun:test";
import { groupStepsByType, STEP_GROUP_LABELS } from "@/lib/plan/group-steps";
import type { PlannedStep, StepType } from "@/types/plan";

function fakeStep(
  index: number,
  type: StepType,
  overrides: Partial<PlannedStep> = {}
): PlannedStep {
  return {
    index,
    type,
    title: `${type} title ${index}`,
    description: `${type} description ${index}`,
    operationCount: 1,
    estimatedFeeLumens: "0.00001",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
    ...overrides,
  };
}

test("groups steps by type, preserving first-occurrence order", () => {
  const steps = [fakeStep(0, "NORMALIZE_SIGNERS"), fakeStep(1, "MERGE")];

  const groups = groupStepsByType(steps);

  expect(groups.map((g) => g.type)).toEqual(["NORMALIZE_SIGNERS", "MERGE"]);
  expect(groups[0].label).toBe("Remove signers");
  expect(groups[1].label).toBe("Merge account");
});

test("collapses batched same-type steps into a single group", () => {
  const steps = [
    fakeStep(0, "REVOKE_SPONSORSHIP", { title: "Revoke sponsorships (batch 1/2)" }),
    fakeStep(1, "REVOKE_SPONSORSHIP", { title: "Revoke sponsorships (batch 2/2)" }),
    fakeStep(2, "MERGE"),
  ];

  const groups = groupStepsByType(steps);

  expect(groups).toHaveLength(2);
  expect(groups[0].type).toBe("REVOKE_SPONSORSHIP");
  expect(groups[0].steps).toHaveLength(2);
  expect(groups[0].steps.map((s) => s.title)).toEqual([
    "Revoke sponsorships (batch 1/2)",
    "Revoke sponsorships (batch 2/2)",
  ]);
});

test("keeps interleaved same-type steps together at their first-occurrence position", () => {
  const steps = [
    fakeStep(0, "CLAIM_BALANCES"),
    fakeStep(1, "CONVERT_ASSETS"),
    fakeStep(2, "CLAIM_BALANCES"),
    fakeStep(3, "MERGE"),
  ];

  const groups = groupStepsByType(steps);

  expect(groups.map((g) => g.type)).toEqual(["CLAIM_BALANCES", "CONVERT_ASSETS", "MERGE"]);
  expect(groups[0].steps).toHaveLength(2);
});

test("empty plan produces no groups", () => {
  expect(groupStepsByType([])).toEqual([]);
});

const ALL_STEP_TYPES: StepType[] = [
  "NORMALIZE_SIGNERS",
  "REVOKE_SPONSORSHIP",
  "REMOVE_DATA_ENTRIES",
  "CANCEL_OFFERS",
  "ADD_TRUSTLINE_FOR_CLAIM",
  "CLAIM_BALANCES",
  "CONVERT_ASSETS",
  "REMOVE_TRUSTLINES",
  "CLOSE_ACCOUNT",
  "MERGE",
];

test.each(ALL_STEP_TYPES)("every StepType has a non-empty group label (%s)", (type) => {
  expect(STEP_GROUP_LABELS[type]).toBeTruthy();
});
