import { expect, test } from "bun:test";
import type { ProviderQuoteOutcome } from "@/lib/soroswap/conversion-quotes";
import {
  PRICE_IMPACT_FLAG_BPS,
  PROVIDER_DISAGREEMENT_FLAG_BPS,
  derivedImpactBps,
  parsePriceImpactPct,
  pickBestQuote,
  probeAmountFor,
  providersDisagree,
  quoteFlags,
  resolveTokenQuote,
  type ConversionProviderQuote,
  type ProviderOutcomes,
  type TokenQuoteDeps,
} from "@/lib/close-api/multi-source-conversion";

const AMOUNT_IN = 100_000_000n;
/** A Soroswap quote without a `priceImpactPct` field at all. */
const ABSENT = Symbol("absent");

function q(
  provider: "soroswap" | "xbull",
  amountOut: string,
  priceImpactPct: unknown = "0.5"
): ConversionProviderQuote {
  return {
    provider,
    quote: {
      token: "T",
      amountIn: AMOUNT_IN.toString(),
      amountOut,
      minAmountOut: (BigInt(amountOut) - 1n).toString(),
      platform: "router",
      route: [provider],
      raw: (provider === "soroswap"
        ? priceImpactPct === ABSENT
          ? {}
          : { priceImpactPct }
        : { route: "r" }) as never,
    },
  };
}

function quoted(c: ConversionProviderQuote): ProviderQuoteOutcome {
  return { kind: "quote", quote: c.quote };
}

function outcomes(
  soroswap: ProviderQuoteOutcome,
  xbull: ProviderQuoteOutcome = { kind: "disabled" }
): ProviderOutcomes {
  return { soroswap, xbull };
}

/** A probe answering proportionally to the full quote's own rate, scaled by `ratio`. */
function probeAt(fullOut: bigint, ratio = 1): TokenQuoteDeps["probeXBull"] {
  return async (probeIn) => ({
    kind: "quote",
    quote: {
      ...q("xbull", "1").quote,
      amountIn: probeIn.toString(),
      amountOut: (
        (fullOut * probeIn * BigInt(Math.round(ratio * 1000))) /
        AMOUNT_IN /
        1000n
      ).toString(),
    },
  });
}

const routeOk: TokenQuoteDeps["resolveXBullRoute"] = async () => ["T", "XLM"];
const noProbe: TokenQuoteDeps["probeXBull"] = async () => ({ kind: "unavailable" });

test("pickBestQuote returns the higher amountOut, null on an empty list", () => {
  expect(pickBestQuote([])).toBeNull();
  expect(pickBestQuote([q("soroswap", "100"), q("xbull", "110")])?.provider).toBe("xbull");
  expect(pickBestQuote([q("xbull", "90"), q("soroswap", "100")])?.provider).toBe("soroswap");
});

test("parsePriceImpactPct reads a percentage into basis points, rounding up, and refuses anything else", () => {
  expect(parsePriceImpactPct("0")).toBe(0);
  expect(parsePriceImpactPct("0.02")).toBe(2);
  expect(parsePriceImpactPct("4.99")).toBe(499);
  expect(parsePriceImpactPct("5")).toBe(500);
  expect(parsePriceImpactPct("5.001")).toBe(501);
  expect(parsePriceImpactPct("12.5")).toBe(1250);
  expect(parsePriceImpactPct(3.25)).toBe(325);
  expect(parsePriceImpactPct("250")).toBe(10_000);
  // A trade that improves on the spot price has no impact to flag.
  expect(parsePriceImpactPct("-0.3")).toBe(0);
  for (const bad of [undefined, null, "", "abc", "1e3", "1,5", "NaN", {}, Number.NaN]) {
    expect(parsePriceImpactPct(bad)).toBeNull();
  }
});

test("Soroswap's priceImpactPct is a percentage: the SDK's own fixture shape reads as basis points", async () => {
  // The unit comes from the SDK itself, which prints the field as a percentage:
  // soroswap/sdk tests/integration/quote.integration.test.ts:114 logs `${quote.priceImpactPct}%`
  // and examples/backend-example.js:59 logs `quote.priceImpactPct + '%'`; its fixtures in
  // tests/quote.test.ts carry "0.00". The type is a bare string.
  const read = async (priceImpactPct: string) => {
    const result = await resolveTokenQuote(
      outcomes(quoted(q("soroswap", "100", priceImpactPct))),
      { resolveXBullRoute: routeOk, probeXBull: noProbe },
      "T",
      AMOUNT_IN,
      "XLM"
    );
    return result.kind === "quoted" ? result.summary : null;
  };
  expect(await read("0.57")).toMatchObject({ priceImpactBps: 57, flags: [] });
  expect(await read("5.00")).toMatchObject({ priceImpactBps: 500, flags: [] });
  expect(await read("5.01")).toMatchObject({ priceImpactBps: 501, flags: ["high_impact"] });
  expect(await read("0.05")).toMatchObject({ priceImpactBps: 5, flags: [] });
});

test("the impact threshold flags strictly above 5%, and a missing impact is flagged as unknown", () => {
  expect(PRICE_IMPACT_FLAG_BPS).toBe(500);
  expect(quoteFlags(500, false)).toEqual([]);
  expect(quoteFlags(501, false)).toEqual(["high_impact"]);
  expect(quoteFlags(null, false)).toEqual(["impact_unknown"]);
  expect(quoteFlags(10, true)).toEqual(["provider_disagreement"]);
});

test("providers disagree only when the winner is more than 10% above the runner-up", () => {
  expect(PROVIDER_DISAGREEMENT_FLAG_BPS).toBe(1_000);
  expect(providersDisagree(110n, 100n)).toBe(false);
  expect(providersDisagree(1101n, 1000n)).toBe(true);
  expect(providersDisagree(1099n, 1000n)).toBe(false);
});

test("the probe is a thousandth of the balance, never less than one unit", () => {
  expect(probeAmountFor(100_000n)).toBe(100n);
  expect(probeAmountFor(999n)).toBe(1n);
  expect(probeAmountFor(1n)).toBe(1n);
});

test("derived impact measures the full trade's rate against the probe's, clamped and rounded up", () => {
  // Same rate at both sizes: no impact.
  expect(derivedImpactBps(1_000_000n, 50_000_000n, 1_000n, 50_000n)).toBe(0);
  // The full trade fetches 40% less per unit.
  expect(derivedImpactBps(1_000_000n, 30_000_000n, 1_000n, 50_000n)).toBe(4_000);
  // A probe that fetches less per unit than the full trade (a fee on the small size) is never a
  // negative impact.
  expect(derivedImpactBps(1_000_000n, 60_000_000n, 1_000n, 50_000n)).toBe(0);
  // Rounded up: 1 - 0.94999 is just over 5%.
  expect(derivedImpactBps(100_000n, 9_499_900n, 100n, 10_000n)).toBe(501);
  // Nothing to measure against: the probe returned 0, too little, or is not smaller.
  expect(derivedImpactBps(1_000_000n, 50_000_000n, 1_000n, 0n)).toBeNull();
  expect(derivedImpactBps(1_000_000n, 50_000_000n, 1_000n, 9_999n)).toBeNull();
  expect(derivedImpactBps(1n, 50_000_000n, 1n, 50_000_000n)).toBeNull();
});

test("a Soroswap win carries its own impact; at or below the threshold it is unchanged and unflagged", async () => {
  const result = await resolveTokenQuote(
    outcomes(quoted(q("soroswap", "100", "4.99"))),
    { resolveXBullRoute: routeOk, probeXBull: noProbe },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(result).toEqual({
    kind: "quoted",
    summary: {
      amountOut: "100",
      minAmountOut: "99",
      platform: "router",
      provider: "soroswap",
      route: ["soroswap"],
      priceImpactBps: 499,
      flags: [],
    },
  });
});

test("a Soroswap win above the impact threshold, or with a missing or malformed impact, is flagged", async () => {
  for (const [impact, flag] of [
    ["5.01", "high_impact"],
    [ABSENT, "impact_unknown"],
    ["n/a", "impact_unknown"],
  ] as const) {
    const result = await resolveTokenQuote(
      outcomes(quoted(q("soroswap", "100", impact))),
      { resolveXBullRoute: routeOk, probeXBull: noProbe },
      "T",
      AMOUNT_IN,
      "XLM"
    );
    expect(result.kind === "quoted" && result.summary.flags).toEqual([flag]);
  }
});

test("an xBull win derives its impact from a probe quote at a thousandth of the balance", async () => {
  const probed: bigint[] = [];
  const result = await resolveTokenQuote(
    outcomes(quoted(q("soroswap", "50000000")), quoted(q("xbull", "52000000"))),
    {
      resolveXBullRoute: routeOk,
      probeXBull: async (probeIn) => {
        probed.push(probeIn);
        // The probe fetches 2x per unit: the full trade loses half the price.
        return { kind: "quote", quote: { ...q("xbull", "104000").quote } };
      },
    },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(probed).toEqual([AMOUNT_IN / 1000n]);
  expect(result.kind === "quoted" && result.summary).toMatchObject({
    provider: "xbull",
    resolvedPath: ["T", "XLM"],
    priceImpactBps: 5_000,
    flags: ["high_impact"],
    runnerUp: { provider: "soroswap", amountOut: "50000000", minAmountOut: "49999999" },
  });
});

test("an xBull probe that fails or returns 0 leaves the impact unknown, which is flagged", async () => {
  for (const probe of [noProbe, probeAt(52_000_000n, 0)]) {
    const result = await resolveTokenQuote(
      outcomes({ kind: "no_route" }, quoted(q("xbull", "52000000"))),
      { resolveXBullRoute: routeOk, probeXBull: probe },
      "T",
      AMOUNT_IN,
      "XLM"
    );
    expect(result.kind === "quoted" && result.summary.priceImpactBps).toBeNull();
    expect(result.kind === "quoted" && result.summary.flags).toEqual(["impact_unknown"]);
  }
});

test("an xBull probe that answers more than its proportional share reads as impact, one that answers less reads as 0", async () => {
  const run = (ratio: number) =>
    resolveTokenQuote(
      outcomes({ kind: "no_route" }, quoted(q("xbull", "52000000"))),
      { resolveXBullRoute: routeOk, probeXBull: probeAt(52_000_000n, ratio) },
      "T",
      AMOUNT_IN,
      "XLM"
    );
  const more = await run(1.25);
  expect(more.kind === "quoted" && more.summary.priceImpactBps).toBe(2_000);
  const less = await run(0.8);
  expect(less.kind === "quoted" && less.summary.priceImpactBps).toBe(0);
  expect(less.kind === "quoted" && less.summary.flags).toEqual([]);
});

test("when both providers answer and the winner is materially better, both are carried and the winner is flagged", async () => {
  const result = await resolveTokenQuote(
    outcomes(quoted(q("soroswap", "1200", "0.1")), quoted(q("xbull", "1000"))),
    { resolveXBullRoute: routeOk, probeXBull: noProbe },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(result.kind === "quoted" && result.summary).toMatchObject({
    provider: "soroswap",
    amountOut: "1200",
    flags: ["provider_disagreement"],
    runnerUp: { provider: "xbull", amountOut: "1000" },
  });
  const close = await resolveTokenQuote(
    outcomes(quoted(q("soroswap", "1100", "0.1")), quoted(q("xbull", "1000"))),
    { resolveXBullRoute: routeOk, probeXBull: noProbe },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(close.kind === "quoted" && close.summary.flags).toEqual([]);
});

test("an xBull win whose route cannot be confirmed falls back to the next-best quote, which carries no runner-up", async () => {
  for (const resolve of [
    async () => undefined,
    async () => [],
    async () => ["SOME_OTHER_TOKEN", "XLM"],
    async () => ["T", "SOME_OTHER_ASSET"],
    async () => {
      throw new Error("xbull swap-and-build endpoint down");
    },
  ] as TokenQuoteDeps["resolveXBullRoute"][]) {
    const result = await resolveTokenQuote(
      outcomes(quoted(q("soroswap", "100", "0.1")), quoted(q("xbull", "110"))),
      { resolveXBullRoute: resolve, probeXBull: noProbe },
      "T",
      AMOUNT_IN,
      "XLM"
    );
    expect(result.kind === "quoted" && result.summary.provider).toBe("soroswap");
    expect(result.kind === "quoted" && result.summary).not.toHaveProperty("resolvedPath");
    expect(result.kind === "quoted" && result.summary).not.toHaveProperty("runnerUp");
  }
});

test("the xBull resolver is never called for a Soroswap win", async () => {
  let called = false;
  const result = await resolveTokenQuote(
    outcomes(quoted(q("soroswap", "100", "0.1"))),
    {
      resolveXBullRoute: async () => {
        called = true;
        return ["T", "XLM"];
      },
      probeXBull: noProbe,
    },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(called).toBe(false);
  expect(result.kind === "quoted" && result.summary).not.toHaveProperty("resolvedPath");
});

test("without a quote, a provider failure is provider_unavailable and only answers of no route are no_route", async () => {
  const deps = { resolveXBullRoute: routeOk, probeXBull: noProbe };
  const reason = async (o: ProviderOutcomes) => {
    const r = await resolveTokenQuote(o, deps, "T", AMOUNT_IN, "XLM");
    return r.kind === "unquoted" ? r.reason : r.kind;
  };
  expect(await reason(outcomes({ kind: "no_route" }, { kind: "no_route" }))).toBe("no_route");
  expect(await reason(outcomes({ kind: "no_route" }, { kind: "disabled" }))).toBe("no_route");
  expect(await reason(outcomes({ kind: "disabled" }, { kind: "disabled" }))).toBe("no_route");
  expect(await reason(outcomes({ kind: "unavailable" }, { kind: "no_route" }))).toBe(
    "provider_unavailable"
  );
  expect(await reason(outcomes({ kind: "no_route" }, { kind: "rate_limited" }))).toBe(
    "provider_unavailable"
  );
  // xBull's quote stands alone and its route cannot be confirmed: a failure, not a market fact.
  const unconfirmed = await resolveTokenQuote(
    outcomes({ kind: "no_route" }, quoted(q("xbull", "110"))),
    { resolveXBullRoute: async () => undefined, probeXBull: noProbe },
    "T",
    AMOUNT_IN,
    "XLM"
  );
  expect(unconfirmed).toEqual({ kind: "unquoted", reason: "provider_unavailable" });
});
