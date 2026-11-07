import { describe, expect, test } from "bun:test";
import type { CloseTransactionProgress } from "@lumenwipe/sdk";
import {
  activeStepIndex,
  confirmedTransactions,
  formatElapsed,
  isStalled,
  positionOf,
  progressLine,
  type CloseProgress,
} from "@/lib/execution/progress";
import type { PlannedStep } from "@/types/plan";

const at = (
  n: number,
  total: number,
  atLeast = false,
  wait: CloseProgress["wait"] = "wallet"
): CloseProgress => ({ wait, position: { n, total, atLeast }, since: 0 });

const event = (over: Partial<CloseTransactionProgress>): CloseTransactionProgress => ({
  phase: "awaiting-signature",
  round: 0,
  txIndex: 0,
  txCount: 1,
  covers: [],
  moreRoundsExpected: false,
  ...over,
});

const step = (index: number, status: PlannedStep["status"], txHash: string | null = null) =>
  ({ index, status, txHash }) as PlannedStep;

describe("progressLine", () => {
  test("names the transaction, the count and what is waited on", () => {
    expect(progressLine(at(2, 3))).toBe("Transaction 2 of 3: approve in your wallet");
    expect(progressLine(at(2, 3, false, "network"))).toBe(
      "Transaction 2 of 3: confirming on Stellar (usually under 10 seconds)"
    );
    expect(progressLine(at(1, 1, false, "key"))).toBe("Transaction 1 of 1: signing with your key");
    expect(progressLine(at(1, 2, false, "relay"))).toBe(
      "Transaction 1 of 2: getting the relay account's signature"
    );
    expect(progressLine(at(1, 2, false, "sponsor"))).toBe(
      "Transaction 1 of 2: requesting a sponsored fee"
    );
    expect(progressLine(at(1, 2, false, "verifying"))).toBe(
      "Transaction 1 of 2: checking it matches your choices"
    );
  });

  test("says 'at least' when more rounds are expected", () => {
    expect(progressLine(at(2, 3, true))).toBe(
      "Transaction 2 of at least 3: approve in your wallet"
    );
  });

  test("a wait with no transaction yet reads on its own", () => {
    expect(progressLine({ wait: "preparing", position: null, since: 0 })).toBe(
      "Preparing transactions…"
    );
    expect(progressLine({ wait: "checking", position: null, since: 0 })).toBe(
      "Checking the network…"
    );
    expect(progressLine({ wait: "wallet", position: null, since: 0 })).toBe(
      "Approve in your wallet"
    );
  });
});

describe("positionOf", () => {
  test("counts across rounds from the transactions already confirmed", () => {
    // Round 2 of a close whose first round confirmed two transactions.
    expect(positionOf(event({ txIndex: 0, txCount: 2, round: 1 }), 0, 2)).toEqual({
      n: 3,
      total: 4,
      atLeast: false,
    });
  });

  test("a retry keeps counting from what the plan already records", () => {
    expect(positionOf(event({ txIndex: 0, txCount: 1, moreRoundsExpected: true }), 2, 0)).toEqual({
      n: 3,
      total: 3,
      atLeast: true,
    });
  });

  test("a confirmation is numbered as the transaction it confirms", () => {
    expect(positionOf(event({ phase: "confirmed", txIndex: 0, txCount: 2 }), 0, 1)).toEqual({
      n: 1,
      total: 2,
      atLeast: false,
    });
  });
});

test("isStalled after 20 seconds on one wait, never on a confirmation", () => {
  expect(isStalled(at(1, 1), 19_999)).toBe(false);
  expect(isStalled(at(1, 1), 20_000)).toBe(true);
  expect(isStalled(at(1, 1, false, "confirmed"), 60_000)).toBe(false);
});

test("formatElapsed", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(65)).toBe("1:05");
});

test("confirmedTransactions counts distinct hashes: one transaction can cover several steps", () => {
  expect(
    confirmedTransactions([
      step(0, "confirmed", "a"),
      step(1, "confirmed", "a"),
      step(2, "confirmed", "b"),
      step(3, "pending"),
    ])
  ).toBe(2);
});

test("activeStepIndex is the first step neither confirmed nor skipped", () => {
  expect(activeStepIndex([step(0, "confirmed", "a"), step(1, "skipped"), step(2, "failed")])).toBe(
    2
  );
  expect(activeStepIndex([step(0, "confirmed", "a")])).toBe(-1);
});
