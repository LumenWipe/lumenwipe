import type { QuoteResponse } from "@soroswap/sdk";
import type { TokenQuoteFlag, TokenUnquotedReason } from "@lumenwipe/types";
import type { ProviderQuoteOutcome, TokenConversionQuote } from "@/lib/soroswap/conversion-quotes";
import type { TokenQuoteSummary } from "@/lib/close-api/decisions";

/**
 * What plan time makes of every configured conversion-quote provider's answer for one token: the
 * best quote, how far it moves the price, whether the other provider agrees with it, and, when
 * there is no quote, why. No provider is ever a hard dependency for another. The scheduling
 * (time budget, concurrency, the retry on a rate limit) lives in `token-quote-fanout.ts`.
 */

/** No single provider call inside a plan waits longer than this. */
export const PROVIDER_QUOTE_TIMEOUT_MS = 8_000;

/** A price impact above this, in basis points (5%), flags the conversion. */
export const PRICE_IMPACT_FLAG_BPS = 500;

/** A winning quote more than this above the other provider's, in basis points (10%), flags it. */
export const PROVIDER_DISAGREEMENT_FLAG_BPS = 1_000;

/** xBull's impact is derived from a probe quote at this fraction of the balance. */
export const XBULL_PROBE_DIVISOR = 1_000n;

/** A probe delivering less than this many stroops is too coarse to measure impact against: one
 *  stroop of rounding would already move the figure by more than 0.01%. */
export const XBULL_PROBE_MIN_OUT_STROOPS = 10_000n;

const FULL_BPS = 10_000;

export type ConversionProvider = "soroswap" | "xbull";
export const CONVERSION_PROVIDERS: readonly ConversionProvider[] = ["soroswap", "xbull"];

export interface ConversionProviderQuote {
  provider: ConversionProvider;
  quote: TokenConversionQuote;
}

export type ProviderOutcomes = Record<ConversionProvider, ProviderQuoteOutcome>;

export type TokenQuoteResult =
  | { kind: "quoted"; summary: TokenQuoteSummary }
  | { kind: "unquoted"; reason: Extract<TokenUnquotedReason, "provider_unavailable" | "no_route"> };

export function pickBestQuote(results: ConversionProviderQuote[]): ConversionProviderQuote | null {
  if (results.length === 0) return null;
  return results.reduce((best, cur) =>
    BigInt(cur.quote.amountOut) > BigInt(best.quote.amountOut) ? cur : best
  );
}

/**
 * Soroswap's `priceImpactPct`, a percentage as a decimal string, in basis points. Rounded up, so
 * a figure just past the threshold is never rounded under it. Null when absent or not a plain
 * decimal; a negative impact (the trade improves on the spot price) reads as 0.
 */
export function parsePriceImpactPct(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = /^(-)?(\d{1,6})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  if (match[1]) return 0;
  const fraction = match[3] ?? "";
  let bps = Number(match[2]) * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
  if (/[1-9]/.test(fraction.slice(2))) bps += 1;
  return Math.min(bps, FULL_BPS);
}

/** The probe amount for a balance: a thousandth of it, at least one base unit. */
export function probeAmountFor(amountIn: bigint): bigint {
  const probe = amountIn / XBULL_PROBE_DIVISOR;
  return probe > 0n ? probe : 1n;
}

/**
 * The price impact of a full-size quote measured against a probe at a small fraction of it, in
 * basis points: how much less each unit fetches at full size than at probe size. Rounded up and
 * clamped to [0, 10000]; a probe that fetches less per unit than the full trade reads as 0. Null
 * when the probe is not smaller than the trade or delivers too little to measure against.
 */
export function derivedImpactBps(
  amountIn: bigint,
  amountOut: bigint,
  probeIn: bigint,
  probeOut: bigint
): number | null {
  if (probeIn <= 0n || probeIn >= amountIn || probeOut < XBULL_PROBE_MIN_OUT_STROOPS) return null;
  // Full-size output per unit, relative to the probe's, in basis points, rounded down.
  const relative = (amountOut * probeIn * BigInt(FULL_BPS)) / (probeOut * amountIn);
  const impact = BigInt(FULL_BPS) - relative;
  if (impact <= 0n) return 0;
  return impact >= BigInt(FULL_BPS) ? FULL_BPS : Number(impact);
}

/** Whether the winner delivers more than the disagreement threshold above the runner-up. */
export function providersDisagree(winnerOut: bigint, runnerUpOut: bigint): boolean {
  return (
    winnerOut * BigInt(FULL_BPS) > runnerUpOut * BigInt(FULL_BPS + PROVIDER_DISAGREEMENT_FLAG_BPS)
  );
}

export function quoteFlags(priceImpactBps: number | null, disagreement: boolean): TokenQuoteFlag[] {
  const flags: TokenQuoteFlag[] = [];
  if (priceImpactBps === null) flags.push("impact_unknown");
  else if (priceImpactBps > PRICE_IMPACT_FLAG_BPS) flags.push("high_impact");
  if (disagreement) flags.push("provider_disagreement");
  return flags;
}

export interface TokenQuoteDeps {
  /** Confirms an xBull win's live route (token addresses ending at XLM); undefined when not. */
  resolveXBullRoute: (winner: ConversionProviderQuote) => Promise<string[] | undefined>;
  /** Quotes the same token through xBull at the probe amount. */
  probeXBull: (probeIn: bigint) => Promise<ProviderQuoteOutcome>;
}

function failed(outcome: ProviderQuoteOutcome): boolean {
  return outcome.kind === "unavailable" || outcome.kind === "rate_limited";
}

/**
 * Picks the best of the providers' quotes and, when it is xBull's, confirms the live route the
 * browser's trust anchor will need before it can hold a later `strict_send` call to anything -
 * unlike Soroswap's shape, xBull's call carries no asset-identity argument the browser can read
 * on its own, so a route that plan time cannot confirm right now must never be offered as
 * "convert via xBull". Such a route falls back to the next-best quote, or to none. The winner is
 * then measured: its price impact, and whether the other provider's quote is materially lower.
 *
 * Without a quote, the token is `provider_unavailable` when any provider failed (or an xBull
 * route could not be confirmed), so analyzing again may find one, and `no_route` only when every
 * provider consulted answered that it has none.
 */
export async function resolveTokenQuote(
  outcomes: ProviderOutcomes,
  deps: TokenQuoteDeps,
  token: string,
  amountIn: bigint,
  xlmContract: string
): Promise<TokenQuoteResult> {
  let usable: ConversionProviderQuote[] = CONVERSION_PROVIDERS.flatMap((provider) => {
    const outcome = outcomes[provider];
    return outcome.kind === "quote" ? [{ provider, quote: outcome.quote }] : [];
  });
  let winner = pickBestQuote(usable);
  let resolvedPath: string[] | undefined;
  let routeUnconfirmed = false;
  if (winner?.provider === "xbull") {
    resolvedPath = await deps.resolveXBullRoute(winner).catch(() => undefined);
    // A resolved path that doesn't actually start at this token and end at XLM is exactly as
    // unusable as no path at all - the whole point of resolving it is so the browser can later
    // confirm those two endpoints itself; offering one it would refuse anyway helps nobody.
    if (
      !resolvedPath ||
      resolvedPath.length === 0 ||
      resolvedPath[0] !== token ||
      resolvedPath.at(-1) !== xlmContract
    ) {
      routeUnconfirmed = true;
      usable = usable.filter((r) => r !== winner);
      winner = pickBestQuote(usable);
      resolvedPath = undefined;
    }
  }
  if (!winner) {
    const unavailable = routeUnconfirmed || CONVERSION_PROVIDERS.some((p) => failed(outcomes[p]));
    return { kind: "unquoted", reason: unavailable ? "provider_unavailable" : "no_route" };
  }

  const runnerUp = pickBestQuote(usable.filter((r) => r !== winner));
  let priceImpactBps: number | null;
  if (winner.provider === "soroswap") {
    priceImpactBps = parsePriceImpactPct((winner.quote.raw as QuoteResponse).priceImpactPct);
  } else {
    const probeIn = probeAmountFor(amountIn);
    const probe = await deps
      .probeXBull(probeIn)
      .catch((): ProviderQuoteOutcome => ({ kind: "unavailable" }));
    priceImpactBps =
      probe.kind === "quote"
        ? derivedImpactBps(
            amountIn,
            BigInt(winner.quote.amountOut),
            probeIn,
            BigInt(probe.quote.amountOut)
          )
        : null;
  }
  const disagreement =
    runnerUp !== null &&
    providersDisagree(BigInt(winner.quote.amountOut), BigInt(runnerUp.quote.amountOut));

  return {
    kind: "quoted",
    summary: {
      amountOut: winner.quote.amountOut,
      minAmountOut: winner.quote.minAmountOut,
      platform: winner.quote.platform,
      provider: winner.provider,
      route: winner.quote.route,
      ...(winner.provider === "xbull" && resolvedPath ? { resolvedPath } : {}),
      priceImpactBps,
      flags: quoteFlags(priceImpactBps, disagreement),
      ...(runnerUp
        ? {
            runnerUp: {
              provider: runnerUp.provider,
              amountOut: runnerUp.quote.amountOut,
              minAmountOut: runnerUp.quote.minAmountOut,
            },
          }
        : {}),
    },
  };
}
