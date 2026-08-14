import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DESTINATION_ACK_CHOICE,
  deriveDestinationDecisionPoints,
  destinationDecisionId,
  isDestinationAcknowledged,
} from "@/lib/close-api/decisions";
import { lookupExchange } from "@/lib/exchange-registry";
import type { DecisionAnswer } from "@lumenwipe/types";

// A real registry entry. If this address is ever removed from the registry the assertion below
// fails loudly rather than letting the "recognized destination" cases silently stop testing
// anything, which is exactly the failure this suite exists to prevent.
const KNOWN_EXCHANGE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";
const UNKNOWN = Keypair.random().publicKey();

test("the known-exchange fixture is actually in the registry", () => {
  expect(lookupExchange(KNOWN_EXCHANGE)).not.toBeNull();
});

test("an unrecognized destination requires an acknowledgement", () => {
  const points = deriveDestinationDecisionPoints(UNKNOWN);
  expect(points).toHaveLength(1);
  expect(points[0]!.id).toBe(destinationDecisionId(UNKNOWN));
  expect(points[0]!.type).toBe("confirmation");
  expect(points[0]!.required).toBe(true);
  expect(points[0]!.subject).toEqual({ kind: "destination", address: UNKNOWN });
});

// The whole bug being fixed is that absence of data was read as a safe default. A default here
// would reintroduce it through the front door.
test("the acknowledgement has no default and cannot be silently resolved", () => {
  const [point] = deriveDestinationDecisionPoints(UNKNOWN);
  expect(point!.default).toBe("");
  expect(point!.options.map((o) => o.id)).toEqual([DESTINATION_ACK_CHOICE]);
  expect(point!.options[0]!.recommended).toBeUndefined();
});

test("a recognized exchange destination needs no acknowledgement", () => {
  expect(deriveDestinationDecisionPoints(KNOWN_EXCHANGE)).toEqual([]);
});

test("a null destination produces no decision", () => {
  expect(deriveDestinationDecisionPoints(null)).toEqual([]);
});

test("the correct answer acknowledges the destination", () => {
  const answers: DecisionAnswer[] = [
    { id: destinationDecisionId(UNKNOWN), choice: DESTINATION_ACK_CHOICE },
  ];
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(true);
});

test("silence is not consent", () => {
  expect(isDestinationAcknowledged([], UNKNOWN)).toBe(false);
});

// Answering the right decision with any other value must not pass. The plan endpoint's generic
// "pending" filter only checks that an id was answered, so the choice has to be validated here.
test("answering the destination decision with a different choice does not acknowledge it", () => {
  const answers: DecisionAnswer[] = [
    { id: destinationDecisionId(UNKNOWN), choice: "acknowledged" },
  ];
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(false);
});

test("the acknowledgement choice on a different decision does not acknowledge the destination", () => {
  const answers: DecisionAnswer[] = [{ id: "asset:USDC-GISSUER", choice: DESTINATION_ACK_CHOICE }];
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(false);
});

test("unrelated answers leave the destination unacknowledged", () => {
  const answers: DecisionAnswer[] = [
    { id: "asset:USDC-GISSUER", choice: "convert_to_xlm" },
    { id: "claim:0000abcd", choice: "forfeit" },
  ];
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(false);
});

// The reason the decision id carries the address. An answer is just `{id, choice}`, so an id
// that did not name the address would make this a bare boolean a caller could carry from one
// destination to another: confirm control of a wallet, edit the destination to an exchange
// deposit address, resend the same answers. That is the original bug reached through the gate.
test("an acknowledgement given for one address does not acknowledge another", () => {
  const other = Keypair.random().publicKey();
  const answers: DecisionAnswer[] = [
    { id: destinationDecisionId(other), choice: DESTINATION_ACK_CHOICE },
  ];
  expect(isDestinationAcknowledged(answers, other)).toBe(true);
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(false);
});

// `decisions` arrives as an unvalidated array from the request body, and this gate runs before
// the controller's try block - an unguarded property access here is a 500, not a typed 4xx.
test("malformed answers do not throw", () => {
  const answers = [null, undefined, 42, "nope", {}] as unknown as DecisionAnswer[];
  expect(() => isDestinationAcknowledged(answers, UNKNOWN)).not.toThrow();
  expect(isDestinationAcknowledged(answers, UNKNOWN)).toBe(false);
});
