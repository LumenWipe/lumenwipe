import { test, expect } from "bun:test";
import { decisionPointsToClaimableBalances } from "@/lib/api/plan-adapters";
import type { PlanResponse } from "@/types/close-api";

function plan(decisionPoints: PlanResponse["decisionPoints"]): PlanResponse {
  return {
    planHash: "hash",
    status: "needs_decisions",
    steps: [],
    decisionPoints,
    blockers: [],
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
    execution: { estimatedTransactionCount: 0, transactions: [] },
  };
}

test("decisionPointsToClaimableBalances › maps a currently-claimable point", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal1",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal1",
          asset: "native",
          amount: "5.0000000",
          currentlyClaimable: true,
          predicate: { type: "unconditional" },
        },
        options: [{ id: "claim", recommended: true }, { id: "forfeit" }],
        default: "claim",
        required: true,
      },
    ])
  );
  expect(result).toEqual([
    {
      balanceId: "bal1",
      asset: "native",
      code: "XLM",
      amount: "5.0000000",
      currentlyClaimable: true,
      predicate: { type: "unconditional" },
    },
  ]);
});

test("decisionPointsToClaimableBalances › maps a non-native, not-currently-claimable point", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal2",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal2",
          asset: "USDC:GISSUER",
          amount: "10.0000000",
          currentlyClaimable: false,
          predicate: { type: "before_absolute_time", absBeforeEpoch: "999" },
        },
        options: [{ id: "add_trustline_then_claim" }, { id: "forfeit" }],
        default: "",
        required: true,
      },
    ])
  );
  expect(result).toEqual([
    {
      balanceId: "bal2",
      asset: "USDC:GISSUER",
      code: "USDC",
      amount: "10.0000000",
      currentlyClaimable: false,
      predicate: { type: "before_absolute_time", absBeforeEpoch: "999" },
    },
  ]);
});

test("decisionPointsToClaimableBalances › missing predicate defaults to unconditional", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal3",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal3",
          asset: "native",
          amount: "1.0000000",
          currentlyClaimable: true,
        },
        options: [{ id: "claim" }, { id: "forfeit" }],
        default: "claim",
        required: true,
      },
    ])
  );
  expect(result[0].predicate).toEqual({ type: "unconditional" });
});

test("decisionPointsToClaimableBalances › ignores non-claimable_balance decision points", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "asset:USDC-GISSUER",
        type: "asset_disposition",
        subject: { asset: "USDC:GISSUER", balance: "10", convertible: true },
        options: [{ id: "convert_to_xlm" }],
        default: "convert_to_xlm",
        required: true,
      },
    ])
  );
  expect(result).toEqual([]);
});

test("decisionPointsToClaimableBalances › no decision points → empty list", () => {
  expect(decisionPointsToClaimableBalances(plan([]))).toEqual([]);
});
