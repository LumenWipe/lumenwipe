/**
 * Plan-time token quoting under one time budget, on a fake clock: nothing here waits for real
 * time, and nothing in the fan-out may reach for a real timer.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ProviderQuoteOutcome, TokenConversionQuote } from "@/lib/soroswap/conversion-quotes";
import {
  RATE_LIMIT_RETRY_BASE_MS,
  TOKEN_QUOTE_BUDGET_MS,
  TOKEN_QUOTE_CONCURRENCY,
  quoteTokens,
  tokenQuoteBudgetMs,
  type FanoutProviders,
  type TokenQuoteJob,
} from "@/lib/close-api/token-quote-fanout";
import { PROVIDER_QUOTE_TIMEOUT_MS } from "@/lib/close-api/multi-source-conversion";
import { FakeClock } from "./fixtures/fake-clock";

afterEach(() => {
  mock.restore();
});

function quote(token: string, amountOut = "5000000"): ProviderQuoteOutcome {
  const q: TokenConversionQuote = {
    token,
    amountIn: "100000000",
    amountOut,
    minAmountOut: (BigInt(amountOut) - 1n).toString(),
    platform: "aggregator",
    route: ["soroswap"],
    raw: { priceImpactPct: "0.1" } as never,
  };
  return { kind: "quote", quote: q };
}

function jobs(n: number): TokenQuoteJob[] {
  return Array.from({ length: n }, (_, i) => ({ contract: `T${i}`, amountIn: 100_000_000n }));
}

function providers(
  soroswap: FanoutProviders["quote"]["soroswap"],
  xbull: FanoutProviders["quote"]["xbull"] = async () => ({ kind: "disabled" })
): FanoutProviders {
  return { quote: { soroswap, xbull }, resolveXBullRoute: async () => undefined };
}

test("the budget is 20 s, capped at the request's remaining deadline less 10 s, never negative", () => {
  expect(TOKEN_QUOTE_BUDGET_MS).toBe(20_000);
  expect(tokenQuoteBudgetMs(undefined)).toBe(20_000);
  expect(tokenQuoteBudgetMs(40_000)).toBe(20_000);
  expect(tokenQuoteBudgetMs(30_000)).toBe(20_000);
  expect(tokenQuoteBudgetMs(25_000)).toBe(15_000);
  expect(tokenQuoteBudgetMs(10_000)).toBe(0);
  expect(tokenQuoteBudgetMs(3_000)).toBe(0);
});

test("a token the budget does not reach is provider_unavailable, and the fan-out ends inside the budget", async () => {
  const clock = new FakeClock();
  const slow = providers((token) => clock.after(7_000, quote(token)));
  const results = await clock.run(quoteTokens(jobs(12), slow, "XLM", 20_000, clock));
  // Batches of 4 finish at 7 s and 14 s; the third starts with 6 s left and runs out.
  const quoted = Object.values(results).filter((r) => r.kind === "quoted").length;
  expect(quoted).toBe(8);
  for (let i = 8; i < 12; i++) {
    expect(results[`T${i}`]).toEqual({ kind: "unquoted", reason: "provider_unavailable" });
  }
  expect(clock.now()).toBeLessThanOrEqual(20_000);
});

test("a zero budget quotes nothing and calls no provider", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const results = await clock.run(
    quoteTokens(
      jobs(3),
      providers(async (token) => {
        calls += 1;
        return quote(token);
      }),
      "XLM",
      0,
      clock
    )
  );
  expect(calls).toBe(0);
  expect(Object.values(results).every((r) => r.kind === "unquoted")).toBe(true);
});

test("every provider call is capped at 8 s; a hung provider never holds up the other", async () => {
  const clock = new FakeClock();
  const hung = providers(
    () => new Promise<ProviderQuoteOutcome>(() => {}),
    (token) => clock.after(100, { ...quote(token, "4000000") })
  );
  hung.resolveXBullRoute = async () => ["T0", "XLM"];
  const results = await clock.run(quoteTokens(jobs(1), hung, "XLM", 20_000, clock));
  expect(PROVIDER_QUOTE_TIMEOUT_MS).toBe(8_000);
  // The race ends at the 8 s cap; xBull's impact probe then takes its own 100 ms.
  expect(clock.now()).toBe(8_000 + 100);
  expect(results.T0?.kind === "quoted" && results.T0.summary.provider).toBe("xbull");
});

test("a call is capped by the budget left when that is under 8 s", async () => {
  const clock = new FakeClock();
  const results = await clock.run(
    quoteTokens(
      jobs(1),
      providers(() => new Promise(() => {})),
      "XLM",
      3_000,
      clock
    )
  );
  expect(clock.now()).toBe(3_000);
  expect(results.T0).toEqual({ kind: "unquoted", reason: "provider_unavailable" });
});

test("the xBull route resolution and probe are bounded by the same cap", async () => {
  const clock = new FakeClock();
  const p = providers(
    (token) => clock.after(10, quote(token, "1000000")),
    (token) => clock.after(10, { ...quote(token, "2000000") })
  );
  p.resolveXBullRoute = () => new Promise(() => {});
  const results = await clock.run(quoteTokens(jobs(1), p, "XLM", 20_000, clock));
  // The route never confirms: the cap ends the wait and the Soroswap quote stands in.
  expect(clock.now()).toBe(10 + 8_000);
  expect(results.T0?.kind === "quoted" && results.T0.summary.provider).toBe("soroswap");
});

test("no more than 4 tokens are quoted at a time", async () => {
  const clock = new FakeClock();
  let inFlight = 0;
  let peak = 0;
  const p = providers(async (token) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await clock.sleep(1_000);
    inFlight -= 1;
    return quote(token);
  });
  const results = await clock.run(quoteTokens(jobs(10), p, "XLM", 20_000, clock));
  expect(TOKEN_QUOTE_CONCURRENCY).toBe(4);
  expect(peak).toBe(4);
  expect(Object.values(results).every((r) => r.kind === "quoted")).toBe(true);
  expect(clock.now()).toBe(3_000);
});

test("a 429 is retried once after a jittered pause, and then answers", async () => {
  const clock = new FakeClock();
  clock.rand = 0.25;
  const at: number[] = [];
  const p = providers(async (token) => {
    at.push(clock.now());
    return at.length === 1 ? { kind: "rate_limited" } : quote(token);
  });
  const results = await clock.run(quoteTokens(jobs(1), p, "XLM", 20_000, clock));
  expect(at).toEqual([0, RATE_LIMIT_RETRY_BASE_MS + 250]);
  expect(results.T0?.kind).toBe("quoted");
});

test("a 429 is retried only once; still limited, the token is provider_unavailable", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const p = providers(async () => {
    calls += 1;
    return { kind: "rate_limited" };
  });
  const results = await clock.run(quoteTokens(jobs(1), p, "XLM", 20_000, clock));
  expect(calls).toBe(2);
  expect(results.T0).toEqual({ kind: "unquoted", reason: "provider_unavailable" });
});

test("no retry when the budget left cannot fit the pause", async () => {
  const clock = new FakeClock();
  clock.rand = 0.99;
  let calls = 0;
  const p = providers(async () => {
    calls += 1;
    return { kind: "rate_limited" };
  });
  await clock.run(quoteTokens(jobs(1), p, "XLM", 1_000, clock));
  expect(calls).toBe(1);
});

test("against a provider limited to one request a second, every token is quoted or provider_unavailable, never no_route", async () => {
  const clock = new FakeClock();
  let lastServed = -Infinity;
  const limited = providers(async (token) => {
    await clock.sleep(200);
    if (clock.now() - lastServed < 1_000) return { kind: "rate_limited" };
    lastServed = clock.now();
    return quote(token);
  });
  const results = await clock.run(quoteTokens(jobs(20), limited, "XLM", 20_000, clock));
  const kinds = Object.values(results).map((r) => (r.kind === "quoted" ? "quoted" : r.reason));
  expect(kinds).toHaveLength(20);
  expect(kinds).toContain("quoted");
  expect(kinds).toContain("provider_unavailable");
  expect(kinds).not.toContain("no_route");
  expect(clock.now()).toBeLessThanOrEqual(20_000);
});

test("the fan-out never calls a real timer when it is given a clock", async () => {
  const clock = new FakeClock();
  const realTimeout = spyOn(globalThis, "setTimeout");
  const p = providers(
    async () => ({ kind: "rate_limited" }),
    (token) => clock.after(50, quote(token, "9000000"))
  );
  p.resolveXBullRoute = () => new Promise(() => {});
  await clock.run(quoteTokens(jobs(6), p, "XLM", 20_000, clock));
  expect(realTimeout).not.toHaveBeenCalled();
});
