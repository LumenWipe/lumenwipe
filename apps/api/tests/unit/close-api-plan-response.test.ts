import { test, expect } from "bun:test";
import {
  computePlanHash,
  toExecutionBreakdown,
  assemblePlanResponse,
} from "@/lib/close-api/plan-response";
import type { PlannedStep, StepType, DecisionPoint } from "@lumenwipe/types";

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

const DIRECT = { viaMediator: false, decided: true };
const EXCHANGE = { viaMediator: true, decided: true };

function steps(...groups: [StepType, number, Partial<PlannedStep>?][]): PlannedStep[] {
  return groups.map(([type, operationCount, extra], index) => ({
    ...step(index, type),
    operationCount,
    ...extra,
  }));
}

const TOKEN = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

test("a single-transaction account reports one transaction covering every step", () => {
  const breakdown = toExecutionBreakdown(
    steps(["HANDLE_ASSETS", 1], ["REMOVE_TRUSTLINES", 1], ["MERGE", 1]),
    DIRECT
  );
  expect(breakdown.estimatedTransactionCount).toBe(1);
  expect(breakdown.transactions).toEqual([
    { order: 0, covers: ["HANDLE_ASSETS", "REMOVE_TRUSTLINES", "MERGE"] },
  ]);
});

test("an exchange destination adds the mediator transfer as its own transaction", () => {
  const breakdown = toExecutionBreakdown(steps(["REMOVE_TRUSTLINES", 2], ["MERGE", 2]), EXCHANGE);
  expect(breakdown.estimatedTransactionCount).toBe(2);
  expect(breakdown.transactions.map((t) => t.covers)).toEqual([["REMOVE_TRUSTLINES"], ["MERGE"]]);
});

test("a claimable-balance account takes a claim round before the close", () => {
  const breakdown = toExecutionBreakdown(
    steps(
      ["ADD_TRUSTLINE_FOR_CLAIM", 1],
      ["CLAIM_BALANCES", 2],
      ["HANDLE_ASSETS", 1],
      ["REMOVE_TRUSTLINES", 1],
      ["MERGE", 1]
    ),
    DIRECT
  );
  expect(breakdown.transactions.map((t) => t.covers)).toEqual([
    ["ADD_TRUSTLINE_FOR_CLAIM", "CLAIM_BALANCES"],
    ["HANDLE_ASSETS", "REMOVE_TRUSTLINES", "MERGE"],
  ]);
});

test("a close over the operation cap is split and the continuations say why", () => {
  const breakdown = toExecutionBreakdown(
    steps(["REMOVE_DATA_ENTRIES", 120], ["REMOVE_TRUSTLINES", 30], ["MERGE", 1]),
    DIRECT
  );
  expect(breakdown.estimatedTransactionCount).toBe(2);
  expect(breakdown.transactions).toEqual([
    { order: 0, covers: ["REMOVE_DATA_ENTRIES"] },
    { order: 1, covers: ["REMOVE_DATA_ENTRIES", "REMOVE_TRUSTLINES", "MERGE"], reason: "op_batch" },
  ]);
});

test("each Soroban token move is its own transaction ahead of the classic close, a token left is none", () => {
  const breakdown = toExecutionBreakdown(
    steps(
      ["HANDLE_ASSETS", 1, { affectedAsset: TOKEN }],
      ["HANDLE_ASSETS", 0, { affectedAsset: TOKEN }],
      ["MERGE", 1]
    ),
    DIRECT
  );
  expect(breakdown.estimatedTransactionCount).toBe(2);
});

test("a plan with a DeFi exit has no knowable count", () => {
  expect(toExecutionBreakdown(steps(["EXIT_POSITIONS", 1], ["MERGE", 1]), DIRECT)).toEqual({
    estimatedTransactionCount: null,
    transactions: [],
  });
});

test("a count that depends on an undecided input is unknown, not a guess", () => {
  expect(toExecutionBreakdown(steps(["MERGE", 1]), { viaMediator: false, decided: false })).toEqual(
    { estimatedTransactionCount: null, transactions: [] }
  );
});

test("toExecutionBreakdown reports zero transactions for an empty plan", () => {
  expect(toExecutionBreakdown([], DIRECT)).toEqual({
    estimatedTransactionCount: 0,
    transactions: [],
  });
});

test("assemblePlanResponse status: blocked when blockers exist", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [{ message: "nope" }] },
    decisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("blocked");
  expect(res.blockers[0].message).toBe("nope");
});

test("assemblePlanResponse passes through a blocker's own code", () => {
  const res = assemblePlanResponse({
    buildResult: {
      steps: [step(0, "MERGE")],
      blockers: [{ message: "you chose to forfeit", code: "claimable_balance_forfeited" }],
    },
    decisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.blockers[0].code).toBe("claimable_balance_forfeited");
});

test("assemblePlanResponse falls back to the generic code when a blocker has none", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [{ message: "nope" }] },
    decisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.blockers[0].code).toBe("plan_blocker");
});

test("assemblePlanResponse status: needs_decisions when decision points remain", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: [decisionPoint],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("needs_decisions");
});

test("assemblePlanResponse status: ready when no blockers and no pending decisions", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
  });
  expect(res.status).toBe("ready");
});

test("assemblePlanResponse status: complete when there is nothing to do", () => {
  const res = assemblePlanResponse({
    buildResult: { steps: [], blockers: [] },
    decisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
  });
  expect(res.status).toBe("complete");
});

// ─── Answered decisions stay in the response ─────────────────────────────────
//
// Regression for cards vanishing as they were answered. The controller filters answered
// decisions out of `pending` for the status, and the response used to carry only that subset -
// so the moment the analyze page began sending its answers with the plan request, every
// answered card disappeared from the UI, and a re-analyze with remembered answers showed no
// cards at all. The caller needs the full set to render (it knows its own answers); only the
// status is about what remains.

function pointWithId(id: string): DecisionPoint {
  return {
    id,
    type: "asset_disposition",
    subject: { kind: "trustline", asset: "X:G", balance: "1", convertible: true },
    options: [{ id: "convert_to_xlm" }],
    default: "convert_to_xlm",
    required: true,
  };
}

test("assemblePlanResponse returns every decision point, answered or not", () => {
  const all = [pointWithId("a"), pointWithId("b")];
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: all,
    pendingDecisionPoints: [all[1]!],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "0.5" },
  });
  expect(res.decisionPoints.map((d) => d.id)).toEqual(["a", "b"]);
  expect(res.status).toBe("needs_decisions");
});

test("assemblePlanResponse status: ready once every decision is answered, cards intact", () => {
  const all = [pointWithId("a"), pointWithId("b")];
  const res = assemblePlanResponse({
    buildResult: { steps: [step(0, "MERGE")], blockers: [] },
    decisionPoints: all,
    pendingDecisionPoints: [],
    planHash: "h",
    execution: DIRECT,
    estimate: { feeStroops: "100", freedReserveXlm: "0.5" },
  });
  expect(res.status).toBe("ready");
  expect(res.decisionPoints).toHaveLength(2);
});
