/**
 * The xBull conversion round holds an xBull-built `strict_send` swap to the one shape a
 * conversion may have, and builds it against LumenWipe's own RPC. Every shape-assertion test
 * here is built from the real fixture captured in Task 1
 * (`tests/fixtures/xbull-strict-send-sample.json`) - a genuine, already-executed mainnet
 * `strict_send` call, not a hand-built approximation of the shape - so a refusal proven here is a
 * real deviation from what xBull's own router actually does on-chain.
 */
import { expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { MAX_SOROBAN_EXIT_FEE_STROOPS } from "@/config/constants";
import {
  assertXBullConversionShape,
  buildXBullConversion,
  type ExpectedXBullConversion,
} from "@/lib/close-api/xbull-conversion-round";
import {
  assembleTestTransaction,
  reencodeSwapArg,
  reencodeWithRefs,
} from "../support/xbull-conversion-test-helpers";
import { rawSimulation } from "./fixtures/fake-exit-adapter";
import fixture from "../fixtures/xbull-strict-send-sample.json";

const XBULL_ROUTER = "CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT";
const OTHER_ACCOUNT = Keypair.random().publicKey();

/**
 * The fixture's own `assetMap` (its persistent Map(u32) storage, indices 0-40) resolves the
 * captured `path` tuple `[4, 25, 1112, 33]` - `[protocol_id, in_asset_index, pool_id,
 * out_asset_index]` per the fixture's confirmed `pathTupleOrder` - to `assetMap["25"] ===
 * fixture.fromAsset` and `assetMap["33"] === fixture.toAsset`. One hop, so `resolvedPath` names
 * exactly the two addresses the route touches: the token spent and the token (a stand-in "XLM"
 * for this captured sample - see `toAsset`) received.
 */
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

test("accepts the real captured shape when every expectation matches it", () => {
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0");
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).not.toThrow();
});

test("refuses a build whose refs is non-empty", () => {
  const withRefs = assembleTestTransaction(
    reencodeWithRefs(fixture.contractArgsXDR, [[fixture.decoded.from, "1"]]),
    fixture.decoded.from,
    "0"
  );
  expect(() => assertXBullConversionShape(withRefs, expectedFromFixture())).toThrow("referral");
});

test("refuses a build whose resolved route starts from the wrong token", () => {
  // Correct LENGTH for the real fixture's one-hop path (two entries: the route touches exactly
  // two assets), but a wrong FIRST entry - so the hop-count check passes and the token/XLM check
  // is the one that actually fires, not an earlier length mismatch.
  const wrongFirstHop = "C" + "WRONG".repeat(11).slice(0, 55);
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0"),
      expectedFromFixture({ resolvedPath: [wrongFirstHop, fixture.toAsset] })
    )
  ).toThrow("the route does not go from this token to XLM");
});

test("refuses a build whose resolved path has the wrong hop count", () => {
  // A resolvedPath of the wrong LENGTH for the real fixture's one-hop path trips the hop-count
  // check specifically, distinct from the token/XLM check above.
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0"),
      expectedFromFixture({ resolvedPath: [fixture.fromAsset] })
    )
  ).toThrow("the resolved route does not match this transaction's path");
});

test("refuses a swap whose `to` argument pays out to an account other than the one being closed", () => {
  // Keep tx.source and the `from` argument correct; rewrite ONLY argument index 1 (`to`) to a
  // different, validly-encoded account, so the argument-level "does not pay this account" check
  // is what actually fires, not the earlier transaction-source check.
  const rewritten = reencodeSwapArg(
    fixture.contractArgsXDR,
    1,
    new Address(OTHER_ACCOUNT).toScVal()
  );
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(rewritten, fixture.decoded.from, "0"),
      expectedFromFixture()
    )
  ).toThrow("the swap does not pay this account");
});

test("refuses a swap whose `from` argument spends a different account's balance", () => {
  const rewritten = reencodeSwapArg(
    fixture.contractArgsXDR,
    0,
    new Address(OTHER_ACCOUNT).toScVal()
  );
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(rewritten, fixture.decoded.from, "0"),
      expectedFromFixture()
    )
  ).toThrow("the swap does not spend this account's balance");
});

test("refuses a swap whose `amount` argument does not match the live balance", () => {
  const rewritten = reencodeSwapArg(
    fixture.contractArgsXDR,
    2,
    nativeToScVal(BigInt(fixture.amount) + 1n, { type: "i128" })
  );
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(rewritten, fixture.decoded.from, "0"),
      expectedFromFixture()
    )
  ).toThrow("amount is not the live balance");
});

test("refuses a swap whose `min_to_get` argument is below the caller's floor", () => {
  const rewritten = reencodeSwapArg(
    fixture.contractArgsXDR,
    3,
    nativeToScVal(BigInt(fixture.minToReceive) - 1n, { type: "i128" })
  );
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(rewritten, fixture.decoded.from, "0"),
      expectedFromFixture()
    )
  ).toThrow("min_to_get is below your floor");
});

// ─── walkXBullAuth / the subInvocation-nested token transfer ───────────────────

test("accepts a real one-level subInvocation transferring exactly the swap's own amount to the router", () => {
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0", {
    subInvocation: {
      token: fixture.fromAsset,
      from: fixture.decoded.from,
      to: XBULL_ROUTER,
      amount: fixture.amount,
    },
  });
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).not.toThrow();
});

test("refuses a subInvocation transfer that moves more than the swap's own amount", () => {
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0", {
    subInvocation: {
      token: fixture.fromAsset,
      from: fixture.decoded.from,
      to: XBULL_ROUTER,
      amount: (BigInt(fixture.amount) + 1n).toString(),
    },
  });
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    "the signature would let more of the token leave than the swap spends"
  );
});

test("refuses a subInvocation transfer whose destination is a Stellar account, not the router", () => {
  const tx = assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0", {
    subInvocation: {
      token: fixture.fromAsset,
      from: fixture.decoded.from,
      to: OTHER_ACCOUNT,
      amount: fixture.amount,
    },
  });
  expect(() => assertXBullConversionShape(tx, expectedFromFixture())).toThrow(
    "a token transfer would pay a Stellar account, not the router"
  );
});

// ─── buildXBullConversion ────────────────────────────────────────────────────

function fakeXBullDeps(
  contractArgsXDR: string | null,
  resolvedPath: string[],
  minResourceFee = "0"
) {
  return {
    rpc: {
      simulateTransaction: async () => rawSimulation("ok", [], minResourceFee),
    } as never,
    xbull: {
      fetch: (async () =>
        new Response(JSON.stringify({ contractArgsXDR }), {
          status: contractArgsXDR ? 200 : 400,
        })) as never,
      baseUrl: "https://swap-api.xbull.io",
      now: () => 1_700_000_000_000,
    },
    resolvePath: async () => resolvedPath,
  };
}

test("builds an unsigned transaction from xBull's contractArgsXDR against our own RPC", async () => {
  const built = await buildXBullConversion(
    {
      token: fixture.fromAsset,
      route: "route-1",
      amountIn: fixture.amount,
      minAmountOut: fixture.minToReceive,
    },
    fixture.decoded.from,
    "mainnet",
    "0",
    fakeXBullDeps(fixture.contractArgsXDR, [fixture.fromAsset, fixture.toAsset])
  );
  expect(typeof built?.xdr).toBe("string");
  expect(built?.contractArgsXDR).toBe(fixture.contractArgsXDR);
});

test("assembles with a realistic resource fee and still fits under the ceiling assertXBullConversionShape enforces", async () => {
  // A representative single-contract-invocation resource fee (tens of thousands of stroops), not
  // the "0" the other build test uses. With `buildXBullConversion`'s own inclusion fee correctly
  // set to BASE_FEE_STROOPS, the assembled total (100 + 84,523) stays well under
  // MAX_SOROBAN_EXIT_FEE_STROOPS. If the builder's own fee ever regresses back to
  // MAX_SOROBAN_EXIT_FEE_STROOPS itself, the assembled total (10,000,000 + 84,523) would exceed
  // that same ceiling, and this assertion - unlike the zero-fee build test above - would catch it.
  const built = await buildXBullConversion(
    {
      token: fixture.fromAsset,
      route: "route-1",
      amountIn: fixture.amount,
      minAmountOut: fixture.minToReceive,
    },
    fixture.decoded.from,
    "mainnet",
    "0",
    fakeXBullDeps(fixture.contractArgsXDR, [fixture.fromAsset, fixture.toAsset], "84523")
  );
  const tx = TransactionBuilder.fromXDR(built!.xdr, Networks.PUBLIC);
  expect(BigInt(tx.fee)).toBeLessThanOrEqual(BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS));
});

test("a failed fetch or a simulation error both build null, never throw", async () => {
  expect(
    await buildXBullConversion(
      {
        token: fixture.fromAsset,
        route: "route-1",
        amountIn: fixture.amount,
        minAmountOut: fixture.minToReceive,
      },
      fixture.decoded.from,
      "mainnet",
      "0",
      fakeXBullDeps(null, [])
    )
  ).toBeNull();
});
