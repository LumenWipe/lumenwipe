import type { Network } from "@lumenwipe/types";
import { withTimeout } from "@/lib/utils/with-timeout";
import type { TokenConversionQuote } from "@/lib/soroswap/conversion-quotes";

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
