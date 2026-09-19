import { expect, test } from "bun:test";
import {
  pickBestQuote,
  quoteAllProviders,
  type ConversionProviderQuote,
} from "@/lib/close-api/multi-source-conversion";

function q(provider: "soroswap" | "xbull", amountOut: string): ConversionProviderQuote {
  return {
    provider,
    quote: {
      token: "T",
      amountIn: "100",
      amountOut,
      minAmountOut: (BigInt(amountOut) - 1n).toString(),
      platform: "router",
      route: [provider],
      raw: {} as never,
    },
  };
}
// Ruling (preflight scan, carried from Task 3): TokenConversionQuote carries no `provider`
// field; only the outer ConversionProviderQuote.provider (above) identifies which provider
// answered.

test("pickBestQuote returns the higher amountOut, null on an empty list", () => {
  expect(pickBestQuote([])).toBeNull();
  expect(pickBestQuote([q("soroswap", "100"), q("xbull", "110")])?.provider).toBe("xbull");
  expect(pickBestQuote([q("xbull", "90"), q("soroswap", "100")])?.provider).toBe("soroswap");
});

test("quoteAllProviders returns whichever providers actually answered, and none of a rejection", async () => {
  const results = await quoteAllProviders("T", 100n, "mainnet", {
    soroswap: async () => q("soroswap", "100").quote,
    xbull: async () => {
      throw new Error("xbull down");
    },
  });
  expect(results).toHaveLength(1);
  expect(results[0]!.provider).toBe("soroswap");
});

test("a provider that answers null (no route) is excluded, not a rejection", async () => {
  const results = await quoteAllProviders("T", 100n, "mainnet", {
    soroswap: async () => null,
    xbull: async () => q("xbull", "50").quote,
  });
  expect(results).toEqual([q("xbull", "50")]);
});

test("a provider slower than the timeout is excluded, the other still answers", async () => {
  const results = await quoteAllProviders(
    "T",
    100n,
    "mainnet",
    {
      soroswap: () => new Promise((resolve) => setTimeout(() => resolve(q("soroswap", "100").quote), 50)),
      xbull: async () => q("xbull", "90").quote,
    },
    5
  );
  expect(results).toEqual([q("xbull", "90")]);
});
