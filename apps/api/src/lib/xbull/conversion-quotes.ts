import type { Network } from "@lumenwipe/types";
import { xlmContractId, floorUnderQuote } from "@/lib/soroswap/conversion-quotes";
import type { TokenConversionQuote } from "@/lib/soroswap/conversion-quotes";

/**
 * Soroban token conversion quotes through xBull's swap API (swap-api.xbull.io): a second,
 * independent AMM router, raced alongside Soroswap's, never in place of it. No API key exists
 * for this service and it publishes no rate limit or SLA, so every call here is short-timeout
 * and every failure reads as "no route from this provider," never as an error the round
 * surfaces on its own. Mainnet only: xBull's own SDK defines no testnet swap contract.
 */

export const XBULL_QUOTE_TIMEOUT_MS = 8_000;
const DEFAULT_XBULL_API_URL = "https://swap-api.xbull.io";

function readEnv(): { baseUrl: string; enabled: boolean } {
  return {
    baseUrl: process.env.XBULL_SWAP_API_URL?.trim() || DEFAULT_XBULL_API_URL,
    enabled: process.env.XBULL_CONVERSION_ENABLED === "true",
  };
}

/** Pure function of an env-shaped object, never `process.env` itself: this is what a test
 *  exercises directly, without needing a real environment variable set. */
export function isXBullEnabled(env: { enabled: boolean } = readEnv()): boolean {
  return env.enabled;
}

export interface XBullConversionDeps {
  /** Null when xBull is disabled (the flag is off): every quote/build call reads this, not
   *  `process.env`, directly, mirroring `soroswap/conversion-quotes.ts`'s `sdk: ConversionSdk |
   *  null` - a test injects a real function here regardless of the real environment. */
  fetch: typeof fetch | null;
  baseUrl: string;
  now: () => number;
}

export function defaultXBullConversionDeps(): XBullConversionDeps {
  const env = readEnv();
  return {
    fetch: isXBullEnabled(env) ? globalThis.fetch : null,
    baseUrl: env.baseUrl,
    now: () => Date.now(),
  };
}

interface XBullQuoteResponse {
  route: string;
  fromAmount: string;
  toAmount: string;
  fromAsset: string;
  toAsset: string;
  fee: { platformFee: string; referralsFee: string };
}

function asPositiveBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = BigInt(value);
  return n > 0n ? n : null;
}

export async function quoteTokenToXlmViaXBull(
  token: string,
  amountIn: bigint,
  network: Network,
  deps: XBullConversionDeps = defaultXBullConversionDeps()
): Promise<TokenConversionQuote | null> {
  if (!deps.fetch || network === "testnet" || amountIn <= 0n) return null;
  const assetOut = xlmContractId(network);
  if (token === assetOut) return null;

  let raw: XBullQuoteResponse;
  try {
    const url = new URL("/swaps/quote", deps.baseUrl);
    url.searchParams.set("fromAsset", token);
    url.searchParams.set("toAsset", assetOut);
    url.searchParams.set("amount", amountIn.toString());
    const res = await deps.fetch(url.toString());
    if (!res.ok) return null;
    raw = (await res.json()) as XBullQuoteResponse;
  } catch {
    return null;
  }
  if (raw.fromAsset !== token || raw.toAsset !== assetOut) return null;
  const amountOut = asPositiveBigInt(raw.toAmount);
  const quotedIn = asPositiveBigInt(raw.fromAmount);
  if (amountOut === null || quotedIn !== amountIn) return null;
  const minAmountOut = floorUnderQuote(amountOut);
  if (minAmountOut <= 0n) return null;
  return {
    token,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minAmountOut: minAmountOut.toString(),
    platform: "router",
    route: ["xbull"],
    raw: raw as unknown as TokenConversionQuote["raw"],
  };
}

/** Asks xBull to build a swap for a quoted route, `from` an account to itself, with no
 *  referral fee ever attached (Global Constraints; the module never sends `referralFees`).
 *  Returns only the raw `contractArgsXDR`: the caller assembles and simulates the actual
 *  transaction against LumenWipe's own RPC, never xBull's. */
export async function fetchXBullSwapArgs(
  route: string,
  account: string,
  amount: bigint,
  minToReceive: bigint,
  deps: XBullConversionDeps = defaultXBullConversionDeps()
): Promise<string | null> {
  if (!deps.fetch) return null;
  try {
    const url = new URL("/swaps/strict-send", deps.baseUrl);
    url.searchParams.set("route", route);
    url.searchParams.set("from", account);
    url.searchParams.set("to", account);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("minToReceive", minToReceive.toString());
    const res = await deps.fetch(url.toString());
    if (!res.ok) return null;
    const body = (await res.json()) as { contractArgsXDR?: unknown };
    return typeof body.contractArgsXDR === "string" && body.contractArgsXDR.length > 0
      ? body.contractArgsXDR
      : null;
  } catch {
    return null;
  }
}
