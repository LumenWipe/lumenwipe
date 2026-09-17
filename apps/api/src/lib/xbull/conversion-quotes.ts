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

function readEnv(): { baseUrl: string; enabled: boolean } {
  return {
    baseUrl: process.env.XBULL_SWAP_API_URL?.trim() || "https://swap-api.xbull.io",
    enabled: process.env.XBULL_CONVERSION_ENABLED === "true",
  };
}

export function isXBullEnabled(env: { enabled: boolean } = readEnv()): boolean {
  return env.enabled;
}

export interface XBullConversionDeps {
  fetch: typeof fetch;
  now: () => number;
}

export function defaultXBullConversionDeps(): XBullConversionDeps {
  return { fetch: globalThis.fetch, now: () => Date.now() };
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
  if (network === "testnet" || amountIn <= 0n) return null;
  const assetOut = xlmContractId(network);
  if (token === assetOut) return null;
  const env = readEnv();
  if (!isXBullEnabled(env)) return null;

  let raw: XBullQuoteResponse;
  try {
    const url = new URL("/swaps/quote", env.baseUrl);
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
  const env = readEnv();
  try {
    const url = new URL("/swaps/strict-send", env.baseUrl);
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
