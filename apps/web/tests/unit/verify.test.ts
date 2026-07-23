import { test, expect } from "bun:test";
import { assertCloseIntent, VerificationError, type CloseExpectation } from "@/lib/stellar/verify";
import type { IntentOperation, TxIntent } from "@/types/close-api";

const SRC = "SRC";
const DEST = "DEST";
const MED = "MED";
const ISSUER = "ISSUER";
const ATTACKER = "ATTACKER";

function expectation(over: Partial<CloseExpectation> = {}): CloseExpectation {
  return {
    source: SRC,
    destination: DEST,
    mediator: null,
    memo: null,
    memoRequired: false,
    knownIssuers: [ISSUER],
    ...over,
  };
}

function intent(over: Partial<TxIntent> = {}): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
    memo: null,
    guarantees: { mergeDestination: DEST, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [],
    ...over,
  };
}

const conversion = (destination = SRC, destAsset = "native", destMin = "9"): IntentOperation => ({
  type: "path_payment_strict_send",
  sendAsset: `USDC:${ISSUER}`,
  sendAmount: "10",
  destination,
  destAsset,
  destMin,
  path: [],
});
const merge = (destination: string): IntentOperation => ({ type: "account_merge", destination });
const payment = (destination: string): IntentOperation => ({
  type: "payment",
  destination,
  asset: `USDC:${ISSUER}`,
  amount: "5",
});
const setOptions = (over: Record<string, number | null> = {}): IntentOperation => ({
  type: "set_options",
  signerWeight: 0,
  masterWeight: null,
  lowThreshold: null,
  medThreshold: null,
  highThreshold: null,
  ...over,
});

// ─── Happy paths ─────────────────────────────────────────────────────────────

test("a well-formed direct close passes", () => {
  const i = intent({
    guarantees: { mergeDestination: DEST, paymentsOnlyTo: [SRC, ISSUER], minXlmFromConversions: "9" },
    operations: [setOptions(), conversion(), payment(ISSUER), merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("a well-formed mediator close passes (merge to mediator, forward to destination, memo)", () => {
  const i = intent({
    memo: "deposit-1",
    guarantees: { mergeDestination: MED, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(MED), payment(DEST)],
  });
  expect(() =>
    assertCloseIntent(i, expectation({ mediator: MED, memo: "deposit-1", memoRequired: true }))
  ).not.toThrow();
});

// ─── Tampering is caught ─────────────────────────────────────────────────────

test("rejects a merge to an unexpected destination", () => {
  const i = intent({ guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null } });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a payment to an unexpected address", () => {
  const i = intent({
    guarantees: { mergeDestination: DEST, paymentsOnlyTo: [ATTACKER], minXlmFromConversions: null },
    operations: [payment(ATTACKER), merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a conversion that pays out of the account", () => {
  const i = intent({ operations: [conversion(ATTACKER)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a conversion with no minimum floor", () => {
  const i = intent({ operations: [conversion(SRC, "native", "0")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a trustline that is created/raised instead of removed", () => {
  const i = intent({ operations: [{ type: "change_trust", asset: `USDC:${ISSUER}`, limit: "100" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a data entry that is written instead of removed", () => {
  const i = intent({ operations: [{ type: "manage_data", name: "k", value: "dmFsdWU=" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects an offer that is created instead of cancelled", () => {
  const i = intent({ operations: [{ type: "manage_sell_offer", offerId: "0", amount: "50" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that adds or empowers a signer", () => {
  const i = intent({ operations: [setOptions({ signerWeight: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that disables the master key", () => {
  const i = intent({ operations: [setOptions({ masterWeight: 0 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a memo the user did not set", () => {
  const i = intent({ memo: "not-mine" });
  expect(() => assertCloseIntent(i, expectation({ memo: "mine" }))).toThrow(VerificationError);
});

test("rejects a missing memo when the destination requires one", () => {
  const i = intent({ memo: null, guarantees: { mergeDestination: DEST, paymentsOnlyTo: [], minXlmFromConversions: null } });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "mine", memoRequired: true }))
  ).toThrow(VerificationError);
});

test("rejects a transaction for a different account", () => {
  const i = intent({ source: ATTACKER });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});
