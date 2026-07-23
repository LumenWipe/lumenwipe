import { test, expect } from "bun:test";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { assertCloseIntent, VerificationError, type CloseExpectation } from "@/lib/stellar/verify";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import type { IntentOperation, TxIntent } from "@/types/close-api";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();

function expectation(over: Partial<CloseExpectation> = {}): CloseExpectation {
  return {
    source: SRC,
    destination: DEST,
    mediator: null,
    memo: null,
    memoRequired: false,
    memoType: null,
    ...over,
  };
}

function intent(over: Partial<TxIntent> = {}): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
    memo: null,
    memoType: null,
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
const payment = (destination: string, asset = `USDC:${ISSUER}`): IntentOperation => ({
  type: "payment",
  destination,
  asset,
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

// ─── Happy paths (pure) ──────────────────────────────────────────────────────

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
    memoType: "text",
    guarantees: { mergeDestination: MED, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(MED), payment(DEST, "native")],
  });
  expect(() =>
    assertCloseIntent(
      i,
      expectation({ mediator: MED, memo: "deposit-1", memoRequired: true, memoType: "text" })
    )
  ).not.toThrow();
});

// ─── Round-trip through intentFromXdr (catches decode-shape bugs) ─────────────

function buildXdr(ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(SRC, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}

test("a real close that removes a trustline and cancels an offer passes (zero decodes as 0.0000000)", () => {
  const xdr = buildXdr([
    Operation.manageSellOffer({
      selling: new Asset("USDC", ISSUER),
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(xdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("rejects a real transaction carrying an unrecognized operation", () => {
  const xdr = buildXdr([
    Operation.bumpSequence({ bumpTo: "999" }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(xdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

// ─── Tampering is caught (pure) ──────────────────────────────────────────────

test("rejects a merge to an unexpected destination", () => {
  const i = intent({
    guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null },
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a native-XLM payment to a trustline issuer", () => {
  const i = intent({ operations: [payment(ISSUER, "native")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a payment to an unexpected address", () => {
  const i = intent({ operations: [payment(ATTACKER)] });
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

test("rejects a set_options that raises a threshold", () => {
  const i = intent({ operations: [setOptions({ highThreshold: 2 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a memo the user did not set", () => {
  const i = intent({ memo: "not-mine" });
  expect(() => assertCloseIntent(i, expectation({ memo: "mine" }))).toThrow(VerificationError);
});

test("rejects a missing memo when the destination requires one (even if the user left it blank)", () => {
  const i = intent({ memo: null });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: null, memoRequired: true, memoType: "id" }))
  ).toThrow(VerificationError);
});

test("rejects a memo of the wrong type for the destination", () => {
  const i = intent({ memo: "12345", memoType: "text" });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "12345", memoRequired: true, memoType: "id" }))
  ).toThrow(VerificationError);
});

test("rejects a transaction for a different account", () => {
  const i = intent({ source: ATTACKER });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});
