import { expect, test } from "bun:test";
import { planTransactionCountOf } from "@/lib/api/plan-adapters";
import type { PlanResponse } from "@/types/close-api";

function plan(over: Record<string, unknown> = {}): PlanResponse {
  return {
    planHash: "h",
    status: "ready",
    steps: [],
    decisionPoints: [],
    blockers: [],
    estimate: { feeStroops: "300", freedReserveXlm: "1.5000000" },
    execution: { estimatedTransactionCount: 2, transactions: [] },
    ...over,
  } as PlanResponse;
}

test("keeps the plan's transaction count", () => {
  expect(planTransactionCountOf(plan())).toBe(2);
});

test("an unknown count stays unknown, and anything not a positive whole count is unknown", () => {
  for (const count of [null, 0, -1, 1.5, "2", Number.NaN, undefined]) {
    expect(
      planTransactionCountOf(
        plan({ execution: { estimatedTransactionCount: count, transactions: [] } })
      )
    ).toBeNull();
  }
  expect(planTransactionCountOf(plan({ execution: undefined }))).toBeNull();
});
