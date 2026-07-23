import { test, expect } from "bun:test";
import {
  computePlanHash,
  toExecutionBreakdown,
  assemblePlanResponse,
} from "@/lib/close-api/plan-response";
import type { PlannedStep, StepType } from "@/types/plan";
import type { DecisionPoint } from "@/types/close-api";

function step(index: number, type: StepType): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

const decisionPoint: DecisionPoint = {
  id: "asset:USDC-GISSUER",
  type: "asset_disposition",
  subject: {},
  options: [{ id: "return_to_issuer" }],
  default: "return_to_issuer",
  required: true,
};

test("computePlanHash is stable for the same inputs and changes when any input changes", () => {
  const base = { source: "GSRC", destination: "GDEST", decisions: [], snapshotLedger: 100 };
  const h1 = computePlanHash(base);
  const h2 = computePlanHash({ ...base });
  expect(h1).toBe(h2);
  expect(computePlanHash({ ...base, destination: "GOTHER" })).not.toBe(h1);
  expect(computePlanHash({ ...base, snapshotLedger: 101 })).not.toBe(h1);
});

test("computePlanHash ignores decision ordering", () => {
  const a = computePlanHash({
    source: "GSRC",
    destination: null,
    snapshotLedger: 1,
    decisions: [
      { id: "b", choice: "x" },
      { id: "a", choice: "y" },
    ],
  });
  const b = computePlanHash({
    source: "GSRC",
    destination: null,
    snapshotLedger: 1,
    decisions: [
      { id: "a", choice: "y" },
      { id: "b", choice: "x" },
    ],
  });
  expect(a).toBe(b);
});

test("toExecutionBreakdown collapses a fused-eligible plan into one transaction", () => {
  const steps = [step(0, "CONVERT_ASSETS"), step(1, "REMOVE_TRUSTLINES"), step(2, "MERGE")];
  const breakdown = toExecutionBreakdown(steps);
  expect(breakdown.estimatedTransactionCount).toBe(1);
  expect(breakdown.transactions).toHaveLength(1);
  expect(breakdown.transactions[0].covers).toEqual([
    "CONVERT_ASSETS",
    "REMOVE_TRUSTLINES",
    "MERGE",
  ]);
});

test("toExecutionBreakdown reports zero transactions for an empty plan", () => {
  expect(toExecutionBreakdown([])).toEqual({ estimatedTransactionCount: 0, transactions: [] });
});

test("assemblePlanResponse status: blocked when blockers exist", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [{ message: "nope" }] },
    decisionPoints: [],
    planHash: "h",
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("blocked");
  expect(res.blockers[0].message).toBe("nope");
});

test("assemblePlanResponse status: needs_decisions when decision points remain", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: [decisionPoint],
    planHash: "h",
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("needs_decisions");
});

test("assemblePlanResponse status: ready when no blockers and no pending decisions", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: [],
    planHash: "h",
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("ready");
});

test("assemblePlanResponse status: complete when there is nothing to do", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [], blockers: [] },
    decisionPoints: [],
    planHash: "h",
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
  });
  expect(res.status).toBe("complete");
});
