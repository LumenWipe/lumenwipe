import type { Network } from "@lumenwipe/types";
import { withTimeout } from "@/lib/utils/with-timeout";
import type { TokenConversionQuote } from "@/lib/soroswap/conversion-quotes";
import type { TokenQuoteSummary } from "@/lib/close-api/decisions";

/**
 * Races every configured conversion-quote provider for one token and returns whichever
 * answered with a real route, in whatever order they finished. Never throws: a provider that
 * errors, times out, or has no route for this token is simply absent from the result, and the
 * caller (plan-time quoting, or the build-time round re-quoting its pinned provider) decides
 * what an empty result means. No provider is ever a hard dependency for another.
 */
export const PROVIDER_QUOTE_TIMEOUT_MS = 8_000;

export interface ConversionProviderQuote {
  provider: "soroswap" | "xbull";
  quote: TokenConversionQuote;
}

export interface ConversionProviderFns {
  soroswap: (
    token: string,
    amountIn: bigint,
    network: Network
  ) => Promise<TokenConversionQuote | null>;
  xbull: (
    token: string,
    amountIn: bigint,
    network: Network
  ) => Promise<TokenConversionQuote | null>;
}

export async function quoteAllProviders(
  token: string,
  amountIn: bigint,
  network: Network,
  providers: ConversionProviderFns,
  timeoutMs: number = PROVIDER_QUOTE_TIMEOUT_MS
): Promise<ConversionProviderQuote[]> {
  const attempts: Array<Promise<ConversionProviderQuote | null>> = (
    ["soroswap", "xbull"] as const
  ).map(async (provider) => {
    try {
      const quote = await withTimeout(
        providers[provider](token, amountIn, network),
        timeoutMs,
        `${provider} quote exceeded ${timeoutMs} ms`
      );
      return quote ? { provider, quote } : null;
    } catch {
      return null;
    }
  });
  const settled = await Promise.allSettled(attempts);
  return settled
    .filter(
      (r): r is PromiseFulfilledResult<ConversionProviderQuote | null> => r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter((v): v is ConversionProviderQuote => v !== null);
}

export function pickBestQuote(results: ConversionProviderQuote[]): ConversionProviderQuote | null {
  if (results.length === 0) return null;
  return results.reduce((best, cur) =>
    BigInt(cur.quote.amountOut) > BigInt(best.quote.amountOut) ? cur : best
  );
}

/**
 * Picks the best of the raced quotes and, when it is xBull's, confirms the live route the
 * browser's trust anchor will need before it can hold a later `strict_send` call to anything -
 * unlike Soroswap's shape, xBull's call carries no asset-identity argument the browser can read
 * on its own, so a route that plan time cannot confirm right now must never be offered as
 * "convert via xBull" (a compromised or buggy build could otherwise route the swap into whatever
 * it liked and the browser would have nothing to check it against). xBull's own endpoint is
 * independently known to be unreliable, so this is treated exactly like "no route from this
 * provider" - the same graceful-degradation rule `quoteAllProviders` already applies to a
 * provider that errors or times out - and the next-best candidate from this same race stands in,
 * or nothing does.
 */
export async function resolveTokenQuoteSummary(
  results: ConversionProviderQuote[],
  resolveXBullRoute: (winner: ConversionProviderQuote) => Promise<string[] | undefined>,
  token: string,
  xlmContract: string
): Promise<TokenQuoteSummary | null> {
  let winner = pickBestQuote(results);
  let resolvedPath: string[] | undefined;
  if (winner?.provider === "xbull") {
    resolvedPath = await resolveXBullRoute(winner).catch(() => undefined);
    // A resolved path that doesn't actually start at this token and end at XLM is exactly as
    // unusable as no path at all - the whole point of resolving it is so the browser can later
    // confirm those two endpoints itself; offering one it would refuse anyway helps nobody.
    if (
      !resolvedPath ||
      resolvedPath.length === 0 ||
      resolvedPath[0] !== token ||
      resolvedPath.at(-1) !== xlmContract
    ) {
      winner = pickBestQuote(results.filter((r) => r !== winner));
      resolvedPath = undefined;
    }
  }
  if (!winner) return null;
  return {
    amountOut: winner.quote.amountOut,
    minAmountOut: winner.quote.minAmountOut,
    platform: winner.quote.platform,
    provider: winner.provider,
    route: winner.quote.route,
    ...(winner.provider === "xbull" && resolvedPath ? { resolvedPath } : {}),
  };
}
