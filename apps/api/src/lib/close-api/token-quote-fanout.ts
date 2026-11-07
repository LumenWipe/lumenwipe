import type { ProviderQuoteOutcome } from "@/lib/soroswap/conversion-quotes";
import { withTimeout } from "@/lib/utils/with-timeout";
import {
  CONVERSION_PROVIDERS,
  PROVIDER_QUOTE_TIMEOUT_MS,
  resolveTokenQuote,
  type ConversionProvider,
  type ConversionProviderQuote,
  type ProviderOutcomes,
  type TokenQuoteResult,
} from "@/lib/close-api/multi-source-conversion";

/**
 * Plan-time quoting of every held token, bounded as a whole. A plan answers inside the API's
 * request deadline (40 s), and quoting is only one part of it, so the quotes share one budget and
 * a token the budget never reaches is `provider_unavailable` (analyze again), never "no route".
 * Soroswap's free plan allows about one request a second, so tokens are quoted a few at a time
 * and a rate-limited call is retried once, after a jittered pause, when the budget allows it.
 */

/** The whole quote fan-out finishes inside this. */
export const TOKEN_QUOTE_BUDGET_MS = 20_000;

/** What the rest of the plan keeps of the request deadline after quoting. */
export const TOKEN_QUOTE_DEADLINE_RESERVE_MS = 10_000;

/** Tokens quoted at the same time. */
export const TOKEN_QUOTE_CONCURRENCY = 4;

/** The pause before the one retry of a rate-limited call: the base plus up to the jitter. */
export const RATE_LIMIT_RETRY_BASE_MS = 500;
export const RATE_LIMIT_RETRY_JITTER_MS = 1_000;

/** Time, as the fan-out sees it. Injected so tests run on a fake clock and never wait. */
export interface FanoutClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Settles as `work` does, or rejects once `ms` have passed. */
  timeout<T>(work: Promise<T>, ms: number): Promise<T>;
  /** In [0, 1). */
  random(): number;
}

export function systemClock(): FanoutClock {
  return {
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    timeout: (work, ms) => withTimeout(work, ms, `token quote exceeded ${ms} ms`),
    random: () => Math.random(),
  };
}

/** The budget for one plan's quotes: the full budget, or less when the request has less left. */
export function tokenQuoteBudgetMs(remainingRequestMs: number | undefined): number {
  const cap =
    remainingRequestMs === undefined
      ? TOKEN_QUOTE_BUDGET_MS
      : remainingRequestMs - TOKEN_QUOTE_DEADLINE_RESERVE_MS;
  return Math.max(0, Math.min(TOKEN_QUOTE_BUDGET_MS, cap));
}

export interface TokenQuoteJob {
  contract: string;
  amountIn: bigint;
}

export interface FanoutProviders {
  quote: Record<
    ConversionProvider,
    (token: string, amountIn: bigint) => Promise<ProviderQuoteOutcome>
  >;
  resolveXBullRoute: (winner: ConversionProviderQuote) => Promise<string[] | undefined>;
}

const UNAVAILABLE: ProviderQuoteOutcome = { kind: "unavailable" };

/**
 * Quotes every job, at most `TOKEN_QUOTE_CONCURRENCY` at a time, inside `budgetMs`. Never throws.
 * Every call (a quote, the xBull probe, the xBull route resolution) waits at most
 * `min(PROVIDER_QUOTE_TIMEOUT_MS, budget left)`; one that cannot start for lack of budget is a
 * failure of that provider, not an answer from it.
 */
export async function quoteTokens(
  jobs: readonly TokenQuoteJob[],
  providers: FanoutProviders,
  xlmContract: string,
  budgetMs: number,
  clock: FanoutClock = systemClock()
): Promise<Record<string, TokenQuoteResult>> {
  const deadline = clock.now() + budgetMs;
  const left = (): number => deadline - clock.now();

  async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const ms = Math.min(PROVIDER_QUOTE_TIMEOUT_MS, left());
    if (ms <= 0) return fallback;
    try {
      return await clock.timeout(Promise.resolve().then(work), ms);
    } catch {
      return fallback;
    }
  }

  async function call(work: () => Promise<ProviderQuoteOutcome>): Promise<ProviderQuoteOutcome> {
    const first = await bounded(work, UNAVAILABLE);
    if (first.kind !== "rate_limited") return first;
    const pause =
      RATE_LIMIT_RETRY_BASE_MS + Math.floor(clock.random() * RATE_LIMIT_RETRY_JITTER_MS);
    if (left() <= pause) return first;
    await clock.sleep(pause);
    return bounded(work, UNAVAILABLE);
  }

  async function quoteOne(job: TokenQuoteJob): Promise<TokenQuoteResult> {
    const answers = await Promise.all(
      CONVERSION_PROVIDERS.map((p) => call(() => providers.quote[p](job.contract, job.amountIn)))
    );
    const outcomes = Object.fromEntries(
      CONVERSION_PROVIDERS.map((p, i) => [p, answers[i]!])
    ) as ProviderOutcomes;
    return resolveTokenQuote(
      outcomes,
      {
        resolveXBullRoute: (winner) =>
          bounded(() => providers.resolveXBullRoute(winner), undefined),
        probeXBull: (probeIn) => call(() => providers.quote.xbull(job.contract, probeIn)),
      },
      job.contract,
      job.amountIn,
      xlmContract
    );
  }

  const results: Record<string, TokenQuoteResult> = {};
  let next = 0;
  const workers = Array.from(
    { length: Math.min(TOKEN_QUOTE_CONCURRENCY, jobs.length) },
    async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        results[job.contract] = await quoteOne(job).catch((): TokenQuoteResult => ({
          kind: "unquoted",
          reason: "provider_unavailable",
        }));
      }
    }
  );
  await Promise.all(workers);
  return results;
}
