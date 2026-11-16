import {
  SupportedPlatforms,
  SupportedProtocols,
  TradeType,
  type ExactInQuoteResponse,
} from "@soroswap/sdk";
import type { XBullRawQuote } from "@/lib/soroswap/conversion-quotes";

/** A Soroswap exact-in quote routing `amountIn` of `assetIn` to `amountOut` of `assetOut`. */
export function soroswapQuote(
  assetIn: string,
  assetOut: string,
  over: Partial<ExactInQuoteResponse> = {}
): ExactInQuoteResponse {
  const amountIn = over.amountIn ?? 100_000_000n;
  const amountOut = over.amountOut ?? 5_000_000n;
  return {
    assetIn,
    amountIn,
    assetOut,
    amountOut,
    otherAmountThreshold: amountOut,
    priceImpactPct: "0.02",
    platform: SupportedPlatforms.AGGREGATOR,
    routePlan: [
      {
        swapInfo: { protocol: SupportedProtocols.SOROSWAP, path: [assetIn, assetOut] },
        percent: "100",
      },
    ],
    tradeType: TradeType.EXACT_IN,
    rawTrade: { amountIn, amountOutMin: amountOut, distribution: [] },
    ...over,
  };
}

/** An xBull quote for `fromAmount` of `fromAsset` to `toAmount` of `toAsset`. */
export function xbullRawQuote(over: Partial<XBullRawQuote> = {}): XBullRawQuote {
  return {
    route: "r",
    fromAmount: "100000000",
    toAmount: "5000000",
    fromAsset: "",
    toAsset: "",
    fee: { platformFee: "0", referralsFee: "0" },
    ...over,
  };
}
