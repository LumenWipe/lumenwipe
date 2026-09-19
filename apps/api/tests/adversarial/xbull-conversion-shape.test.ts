/**
 * Adversarial coverage: the xBull `strict_send` shape assertion (docs/architecture.md §9, §10.1;
 * this feature's spec §5.3-§5.4). `xbull-conversion-round.test.ts` already proves the happy path
 * and most single-field deviations against the real captured fixture
 * (`tests/fixtures/xbull-strict-send-sample.json`); this suite instead targets the four hostile
 * shapes named in this feature's own review as the ones worth a dedicated, adversarial-framed
 * test: a floor shaved by exactly one stroop, a second smuggled operation, an authorization tree
 * that reaches somewhere it has no business reaching, and a fee that has drifted past the ceiling
 * every Soroban exit shares. Every case is built from the one real, already-executed mainnet
 * `strict_send` call the fixture captures - never a hand-typed approximation of xBull's shape -
 * so a refusal proven here is a real deviation from what xBull's own router actually does
 * on-chain.
 */
import { expect, test } from "bun:test";
import {
  Networks,
  TransactionBuilder,
  nativeToScVal,
  type Transaction,
} from "@stellar/stellar-sdk";
import { MAX_SOROBAN_EXIT_FEE_STROOPS } from "@/config/constants";
import {
  assertXBullConversionShape,
  type ExpectedXBullConversion,
} from "@/lib/close-api/xbull-conversion-round";
import { assembleTestTransaction, reencodeSwapArg } from "../support/xbull-conversion-test-helpers";
import fixture from "../fixtures/xbull-strict-send-sample.json";

const XBULL_ROUTER = "CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT";
// The fixture's own assetMap index 1 - a real, distinct token contract, never touched by the
// fixture's captured one-hop route (which only ever names index 25 and index 33).
const UNRELATED_CONTRACT = fixture.assetMap["1"];

function expectedFromFixture(over: Partial<ExpectedXBullConversion> = {}): ExpectedXBullConversion {
  return {
    token: fixture.fromAsset,
    account: fixture.decoded.from,
    xlm: fixture.toAsset,
    amountIn: BigInt(fixture.amount),
    minOut: BigInt(fixture.minToReceive),
    resolvedPath: [fixture.fromAsset, fixture.toAsset],
    allowed: { router: [XBULL_ROUTER] },
    sequence: "0",
    nowSeconds: 1_700_000_000,
    ...over,
  };
}

test("a route whose min_to_get is one stroop below the accepted floor is refused", () => {
  const shaved = reencodeSwapArg(
    fixture.contractArgsXDR,
    3,
    nativeToScVal(BigInt(fixture.minToReceive) - 1n, { type: "i128" })
  );
  const tx = assembleTestTransaction(shaved, fixture.decoded.from, "0");
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    "min_to_get is below your floor"
  );
});

test("a swap that pays out to a second operation's account is refused (single-operation rule)", () => {
  // Two independent invokeHostFunction operations for the same real call, smuggled into one
  // envelope - the second operation could just as well pay out anywhere; assertXBullConversionShape
  // must refuse on operation count alone, before it ever inspects a second operation's contents.
  const first = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0");
  const firstOp = first.toEnvelope().v1().tx().operations()[0]!;
  const second = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0");
  const secondOp = second.toEnvelope().v1().tx().operations()[0]!;
  const envelope = first.toEnvelope();
  envelope.v1().tx().operations([firstOp, secondOp]);
  const tx = TransactionBuilder.fromXDR(envelope, Networks.PUBLIC) as Transaction;
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    "expected one operation"
  );
});

test("a swap whose authorization tree reaches a contract other than the token or the router is refused", () => {
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0", {
    subInvocation: {
      token: UNRELATED_CONTRACT,
      from: fixture.decoded.from,
      to: XBULL_ROUTER,
      amount: fixture.amount,
    },
  });
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    `the signature would authorize a call on ${UNRELATED_CONTRACT}, which no swap needs`
  );
});

test("a swap whose fee exceeds MAX_SOROBAN_EXIT_FEE_STROOPS is refused", () => {
  const tooExpensive = (BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS) + 1n).toString();
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0", {
    fee: tooExpensive,
  });
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    "the fee exceeds what a swap can need"
  );
});
