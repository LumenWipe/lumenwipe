import { expect, test } from "bun:test";
import {
  pickBestQuote,
  quoteAllProviders,
  resolveTokenQuoteSummary,
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
      soroswap: () =>
        new Promise((resolve) => setTimeout(() => resolve(q("soroswap", "100").quote), 50)),
      xbull: async () => q("xbull", "90").quote,
    },
    5
  );
  expect(results).toEqual([q("xbull", "90")]);
});

test("resolveTokenQuoteSummary offers an xBull win with its resolvedPath once the route confirms live", async () => {
  const results = [q("soroswap", "100"), q("xbull", "110")];
  const summary = await resolveTokenQuoteSummary(results, async () => ["TOKEN", "XLM"]);
  expect(summary).toEqual({
    amountOut: "110",
    minAmountOut: "109",
    platform: "router",
    provider: "xbull",
    route: ["xbull"],
    resolvedPath: ["TOKEN", "XLM"],
  });
});

test("resolveTokenQuoteSummary falls back to the next-best quote when xBull's route cannot be confirmed", async () => {
  const results = [q("soroswap", "100"), q("xbull", "110")];
  const summary = await resolveTokenQuoteSummary(results, async () => undefined);
  expect(summary).toEqual({
    amountOut: "100",
    minAmountOut: "99",
    platform: "router",
    provider: "soroswap",
    route: ["soroswap"],
  });
});

test("resolveTokenQuoteSummary falls back to null when xBull is the only candidate and its route fails", async () => {
  const results = [q("xbull", "110")];
  const summary = await resolveTokenQuoteSummary(results, async () => undefined);
  expect(summary).toBeNull();
});

test("resolveTokenQuoteSummary treats a thrown resolver and an empty resolved path both as failure", async () => {
  const results = [q("xbull", "110")];
  expect(
    await resolveTokenQuoteSummary(results, async () => {
      throw new Error("xbull swap-and-build endpoint down");
    })
  ).toBeNull();
  expect(await resolveTokenQuoteSummary(results, async () => [])).toBeNull();
});

test("resolveTokenQuoteSummary never calls the xBull resolver for a soroswap win", async () => {
  const results = [q("soroswap", "100")];
  let called = false;
  const summary = await resolveTokenQuoteSummary(results, async () => {
    called = true;
    return ["TOKEN", "XLM"];
  });
  expect(called).toBe(false);
  expect(summary?.provider).toBe("soroswap");
  expect(summary).not.toHaveProperty("resolvedPath");
});
