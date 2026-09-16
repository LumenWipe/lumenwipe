import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DEFI_POSITIONS_ACK_CHOICE,
  defiPositionsDecisionId,
  deriveDefiPositionsDecisionPoints,
  isDefiPositionsAcknowledged,
} from "@/lib/close-api/decisions";
import type { DecisionAnswer } from "@lumenwipe/types";

const ADDRESS = Keypair.random().publicKey();

test("no acknowledgement is required when the gate would not hard-block", () => {
  expect(deriveDefiPositionsDecisionPoints(ADDRESS, false)).toEqual([]);
});

test("an acknowledgement is required when the gate would hard-block", () => {
  const points = deriveDefiPositionsDecisionPoints(ADDRESS, true);
  expect(points).toHaveLength(1);
  expect(points[0]!.id).toBe(defiPositionsDecisionId(ADDRESS));
  expect(points[0]!.type).toBe("confirmation");
  expect(points[0]!.required).toBe(true);
  expect(points[0]!.subject).toEqual({ kind: "defi_positions", address: ADDRESS });
});

// Same reasoning as the destination acknowledgement: absence of data must never read as a safe
// default.
test("the acknowledgement has no default and cannot be silently resolved", () => {
  const [point] = deriveDefiPositionsDecisionPoints(ADDRESS, true);
  expect(point!.default).toBe("");
  expect(point!.options.map((o) => o.id)).toEqual([DEFI_POSITIONS_ACK_CHOICE]);
  expect(point!.options[0]!.recommended).toBeUndefined();
});

test("the correct answer acknowledges the account", () => {
  const answers: DecisionAnswer[] = [
    { id: defiPositionsDecisionId(ADDRESS), choice: DEFI_POSITIONS_ACK_CHOICE },
  ];
  expect(isDefiPositionsAcknowledged(answers, ADDRESS)).toBe(true);
});

test("silence is not consent", () => {
  expect(isDefiPositionsAcknowledged([], ADDRESS)).toBe(false);
});

test("answering the decision with a different choice does not acknowledge it", () => {
  const answers: DecisionAnswer[] = [
    { id: defiPositionsDecisionId(ADDRESS), choice: "acknowledged" },
  ];
  expect(isDefiPositionsAcknowledged(answers, ADDRESS)).toBe(false);
});

// The reason the decision id carries the address: an answer is just `{id, choice}`, so an id
// that did not name the address would let an acknowledgement given for one account (that a
// human actually checked) be replayed for a different one (that nobody looked at).
test("an acknowledgement given for one address does not acknowledge another", () => {
  const other = Keypair.random().publicKey();
  const answers: DecisionAnswer[] = [
    { id: defiPositionsDecisionId(other), choice: DEFI_POSITIONS_ACK_CHOICE },
  ];
  expect(isDefiPositionsAcknowledged(answers, other)).toBe(true);
  expect(isDefiPositionsAcknowledged(answers, ADDRESS)).toBe(false);
});

test("malformed answers do not throw", () => {
  const answers = [null, undefined, 42, "nope", {}] as unknown as DecisionAnswer[];
  expect(() => isDefiPositionsAcknowledged(answers, ADDRESS)).not.toThrow();
  expect(isDefiPositionsAcknowledged(answers, ADDRESS)).toBe(false);
});
