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
  assertXBullConversionShape,
  buildXBullConversion,
  type ExpectedXBullConversion,
} from "@/lib/close-api/xbull-conversion-round";
import { assembleTestTransaction, reencodeWithRefs } from "../support/xbull-conversion-test-helpers";
import { rawSimulation } from "./fixtures/fake-exit-adapter";
import fixture from "../fixtures/xbull-strict-send-sample.json";

const XBULL_ROUTER = "CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT";

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

test("refuses a build whose path does not resolve to this token and XLM", () => {
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0"),
      expectedFromFixture({
        resolvedPath: ["CWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRO7"],
      })
    )
  ).toThrow();
});

test("refuses a build that pays out to an account other than the one being closed", () => {
  expect(() =>
    assertXBullConversionShape(
      assembleTestTransaction(fixture.contractArgsXDR, fixture.decoded.from, "0"),
      expectedFromFixture({ account: "GDIFFERENTACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })
    )
  ).toThrow();
});

// ─── buildXBullConversion ────────────────────────────────────────────────────

function fakeXBullDeps(contractArgsXDR: string | null, resolvedPath: string[]) {
  return {
    rpc: {
      simulateTransaction: async () => rawSimulation("ok", [], "0"),
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
    { token: fixture.fromAsset, route: "route-1", amountIn: fixture.amount, minAmountOut: fixture.minToReceive },
    fixture.decoded.from,
    "mainnet",
    "0",
    fakeXBullDeps(fixture.contractArgsXDR, [fixture.fromAsset, fixture.toAsset])
  );
  expect(typeof built?.xdr).toBe("string");
  expect(built?.contractArgsXDR).toBe(fixture.contractArgsXDR);
});

test("a failed fetch or a simulation error both build null, never throw", async () => {
  expect(
    await buildXBullConversion(
      { token: fixture.fromAsset, route: "route-1", amountIn: fixture.amount, minAmountOut: fixture.minToReceive },
      fixture.decoded.from,
      "mainnet",
      "0",
      fakeXBullDeps(null, [])
    )
  ).toBeNull();
});
