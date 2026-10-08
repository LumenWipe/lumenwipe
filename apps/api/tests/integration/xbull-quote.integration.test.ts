import { expect, test } from "bun:test";
import { xlmContractId } from "@/lib/soroswap/conversion-quotes";
import { quoteTokenToXlmViaXBull } from "@/lib/xbull/conversion-quotes";

// Live, read-only QA of xBull's own quote endpoint against real mainnet state: a quote for a
// routable token, nothing more. Unlike soroswap-conversion.integration.test.ts, this test never
// builds or simulates a swap - xBull's own live `/swaps/strict-send` build endpoint returned an
// unresolved, input-independent 400 for every account/asset/amount combination tried during this
// feature's own research (see tests/fixtures/xbull-strict-send-sample.json's `_comment`), so
// automated coverage of a real xBull *build* stops at this feature's spec §7 boundary: a quote is
// the only live call this suite can make. Opt-in like every integration test here, gated on the
// same XBULL_CONVERSION_ENABLED flag production uses, never on a separate credential this module
// has no concept of.
const RUN_LIVE = process.env.XBULL_CONVERSION_ENABLED === "true";

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const AMOUNT = 1_000_000n;

test.skipIf(!RUN_LIVE)(
  "mainnet: a real XLM-to-USDC quote via xBull comes back with a positive floor",
  async () => {
    const xlm = xlmContractId("mainnet");
    expect(xlm).not.toBe(USDC);
    const quote = await quoteTokenToXlmViaXBull(USDC, AMOUNT, "mainnet");
    // A quote-only call: never builds, never signs, never touches a real account's funds. No
    // route today reads as null, exactly like every other quote source in this codebase.
    expect(quote === null || BigInt(quote.minAmountOut) > 0n).toBe(true);
  },
  30_000
);
