/**
 * Soroswap quotes: the API proposes a route and a price; this module decides whether that is a
 * conversion the close can offer, and computes the floor itself.
 */
import { expect, test } from "bun:test";
import { Address } from "@stellar/stellar-sdk";
import { SupportedPlatforms, TradeType, type QuoteResponse } from "@soroswap/sdk";
import { SLIPPAGE_BPS } from "@/config/constants";
import {
  CONVERSION_PROTOCOLS,
  buildTokenConversion,
  floorUnderQuote,
  isConversionEnabled,
  quoteTokenToXlm,
  xlmContractId,
  type ConversionSdk,
} from "@/lib/soroswap/conversion-quotes";

const TOKEN = Address.contract(Buffer.alloc(32, 1)).toString();
const XLM = xlmContractId("mainnet");

function rawQuote(over: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    assetIn: TOKEN,
    amountIn: 100_000_000n,
    assetOut: XLM,
    amountOut: 524_963_090n,
    // Observed live: the API's own threshold equals the quote - no floor at all.
    otherAmountThreshold: 524_963_090n,
    priceImpactPct: "0.02",
    platform: SupportedPlatforms.AGGREGATOR,
    routePlan: [
      { swapInfo: { protocol: "soroswap" as never, path: [TOKEN, XLM] }, percent: "100" },
    ],
    tradeType: TradeType.EXACT_IN,
    rawTrade: { amountIn: 100_000_000n, amountOutMin: 522_338_275n, distribution: [] },
    ...over,
  } as QuoteResponse;
}

function fakeSdk(
  answer: QuoteResponse | Error,
  xdr = "AAAA"
): ConversionSdk & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async quote(request) {
      calls.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async build(request) {
      calls.push(request);
      return { xdr, action: "swap", description: "" };
    },
  };
}

const deps = (sdk: ConversionSdk | null) => ({ sdk, now: () => 1_700_000_000_000 });

test("a quote becomes a conversion with our own floor under it, never the API's threshold", async () => {
  const sdk = fakeSdk(rawQuote());
  const quote = await quoteTokenToXlm(TOKEN, 100_000_000n, "mainnet", deps(sdk));
  expect(quote).toMatchObject({
    token: TOKEN,
    amountIn: "100000000",
    amountOut: "524963090",
    minAmountOut: floorUnderQuote(524_963_090n).toString(),
    platform: "aggregator",
    route: ["soroswap"],
  });
  expect(BigInt(quote!.minAmountOut)).toBeLessThan(524_963_090n);
  expect(floorUnderQuote(10_000n)).toBe(BigInt(10_000 - SLIPPAGE_BPS));
  // The request asked for every protocol, the whole amount, exact-in, into XLM.
  expect(sdk.calls[0]).toMatchObject({
    assetIn: TOKEN,
    assetOut: XLM,
    amount: 100_000_000n,
    tradeType: TradeType.EXACT_IN,
    protocols: CONVERSION_PROTOCOLS,
  });
});

test("no route, an error, a mismatched or empty answer, or conversion switched off all read as not convertible", async () => {
  expect(
    await quoteTokenToXlm(TOKEN, 1n, "mainnet", deps(fakeSdk(new Error("No path found"))))
  ).toBeNull();
  expect(await quoteTokenToXlm(TOKEN, 1n, "mainnet", deps(null))).toBeNull();
  expect(await quoteTokenToXlm(TOKEN, 0n, "mainnet", deps(fakeSdk(rawQuote())))).toBeNull();
  expect(await quoteTokenToXlm(XLM, 5n, "mainnet", deps(fakeSdk(rawQuote())))).toBeNull();
  const cases: Array<Partial<QuoteResponse>> = [
    { amountOut: 0n },
    { amountIn: 99n },
    { assetOut: TOKEN },
    { assetIn: XLM },
    { platform: "phoenix" as never },
    { platform: "sdex" as never },
    { amountOut: "abc" as never },
  ];
  for (const over of cases) {
    expect(
      await quoteTokenToXlm(TOKEN, 100_000_000n, "mainnet", deps(fakeSdk(rawQuote(over))))
    ).toBeNull();
  }
  // A quote too small to leave anything after slippage is not a swap worth offering.
  expect(
    await quoteTokenToXlm(
      TOKEN,
      1n,
      "mainnet",
      deps(fakeSdk(rawQuote({ amountIn: 1n, amountOut: 1n })))
    )
  ).toBeNull();
});

test("building echoes the API's quote back as the account, and an empty or failed build is null", async () => {
  const sdk = fakeSdk(rawQuote(), "AAAAAgAA");
  const quote = (await quoteTokenToXlm(TOKEN, 100_000_000n, "mainnet", deps(sdk)))!;
  const from = "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK";
  expect(await buildTokenConversion(quote, from, "mainnet", deps(sdk))).toBe("AAAAAgAA");
  expect(sdk.calls[1]).toMatchObject({ quote: quote.raw, from, to: from });
  expect(
    await buildTokenConversion(quote, from, "mainnet", deps(fakeSdk(rawQuote(), "")))
  ).toBeNull();
  expect(await buildTokenConversion(quote, from, "mainnet", deps(null))).toBeNull();
});

test("conversion is enabled only with the flag on and a key set", () => {
  expect(isConversionEnabled({ enabled: true, apiKey: "sk_x", baseUrl: undefined })).toBe(true);
  expect(isConversionEnabled({ enabled: true, apiKey: undefined, baseUrl: undefined })).toBe(false);
  expect(isConversionEnabled({ enabled: false, apiKey: "sk_x", baseUrl: undefined })).toBe(false);
});
