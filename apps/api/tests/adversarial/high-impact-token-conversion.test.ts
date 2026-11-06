/**
 * Adversarial coverage (issue #450): a token quote that moves the price hard, that only one
 * provider vouches for, or whose impact nobody could measure, is never the recommended default.
 * xBull was observed on 2026-11-06 quoting a trade far past its pool's depth (about 98% impact)
 * with no warning field at all, so its impact is derived, not trusted.
 */
import { expect, test } from "bun:test";
import type { ProviderQuoteOutcome } from "@/lib/soroswap/conversion-quotes";
import { resolveTokenQuote } from "@/lib/close-api/multi-source-conversion";
import {
  TRANSFER_CHOICE,
  deriveConversionImpactDecisionPoints,
  deriveTokenDecisionPoints,
} from "@/lib/close-api/decisions";

const TOKEN = "CTOKEN";
const XLM = "CXLM";
const BALANCE = 100_000_000_000_000_000n;

function xbull(amountIn: bigint, amountOut: bigint): ProviderQuoteOutcome {
  return {
    kind: "quote",
    quote: {
      token: TOKEN,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      minAmountOut: ((amountOut * 9_950n) / 10_000n).toString(),
      platform: "router",
      route: ["xbull"],
      raw: { route: "r" } as never,
    },
  };
}

test("a far-too-large xBull quote with no impact field is flagged and never recommended", async () => {
  // The observed shape: 10^10 USDC fetches about 0.1 XLM each against about 6.44 at small size.
  const result = await resolveTokenQuote(
    { soroswap: { kind: "unavailable" }, xbull: xbull(BALANCE, 101_360_465_772_360n) },
    {
      resolveXBullRoute: async () => [TOKEN, XLM],
      probeXBull: async (probeIn) => xbull(probeIn, (probeIn * 644n) / 100n),
    },
    TOKEN,
    BALANCE,
    XLM
  );
  expect(result.kind).toBe("quoted");
  if (result.kind !== "quoted") return;
  expect(result.summary.flags).toContain("high_impact");
  expect(result.summary.priceImpactBps).toBeGreaterThan(9_000);

  const account = {
    sorobanTokens: {
      tokens: [
        {
          contract: TOKEN,
          balance: BALANCE.toString(),
          symbol: "USDC",
          decimals: 7,
          sources: ["explorer" as const],
        },
      ],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
  };
  const [point] = deriveTokenDecisionPoints(account, { [TOKEN]: result.summary });
  expect(point!.default).toBe(TRANSFER_CHOICE);
  expect(point!.options.some((o) => o.recommended)).toBe(false);
  expect(deriveConversionImpactDecisionPoints(account, { [TOKEN]: result.summary })).toHaveLength(
    1
  );
});

test("an xBull quote whose impact cannot be measured is never recommended either", async () => {
  const result = await resolveTokenQuote(
    { soroswap: { kind: "no_route" }, xbull: xbull(BALANCE, 5_000_000n) },
    {
      resolveXBullRoute: async () => [TOKEN, XLM],
      probeXBull: async () => ({ kind: "rate_limited" }),
    },
    TOKEN,
    BALANCE,
    XLM
  );
  expect(result.kind === "quoted" && result.summary.flags).toEqual(["impact_unknown"]);
});
