import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
  type BuildQuoteRequest,
  type BuildQuoteResponse,
  type QuoteRequest,
  type QuoteResponse,
} from "@soroswap/sdk";
import { Asset } from "@stellar/stellar-sdk";
import type { Network } from "@lumenwipe/types";
import { SLIPPAGE_BPS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";

/**
 * Soroban token conversion quotes, through the Soroswap API (#161).
 *
 * The API is the one route source that prices a Soroban-native token: it aggregates Soroswap,
 * Phoenix, and Aquarius pools with the classic order book and builds the swap transaction. It is
 * consulted for two things and trusted for neither: a quote decides whether "convert to XLM" is
 * offered at all and what floor the user is shown, and a build produces bytes the API then
 * decodes and asserts against that floor and the user's own account before offering them to
 * sign. What it says about amounts is checked against the ledger by simulation; what it builds is
 * checked against the shape a swap must have; what it lists as protocols decides nothing here.
 *
 * Disabled unless configured: without an API key no token is ever convertible, and the close
 * offers transfer or leave. Testnet is configured like mainnet, but the API indexes no testnet
 * protocol today, so quotes there return no route and the same fallback applies.
 */

/**
 * The protocols a route may use: the Soroban AMMs the aggregator dispatches to. Not the classic
 * order book (`sdex`): the API fills that with a classic path payment, which only a classic asset
 * can take - and a Soroban-native token has no classic form, so for the tokens this module prices
 * the order book is never a route. A classic asset's own conversion runs through the classic path.
 */
export const CONVERSION_PROTOCOLS: SupportedProtocols[] = [
  SupportedProtocols.SOROSWAP,
  SupportedProtocols.PHOENIX,
  SupportedProtocols.AQUA,
];
/** A quote that takes longer than this is not worth waiting on inside a plan. */
export const QUOTE_TIMEOUT_MS = 8_000;

export interface TokenConversionQuote {
  token: string;
  /** Base units of the token the quote is for. */
  amountIn: string;
  /** Stroops of XLM the route expects to deliver. */
  amountOut: string;
  /** The least XLM (stroops) the swap may deliver: the quote less the slippage margin. This is
   *  computed here, never taken from the API - its own threshold has been observed equal to the
   *  quote itself, which is no floor at all. */
  minAmountOut: string;
  /** Which of the API's Soroban execution shapes the quote routes through. */
  platform: "aggregator" | "router";
  /** The route, as protocol names, for display. */
  route: string[];
  /** The API's quote, echoed back to it verbatim to build the transaction. */
  raw: QuoteResponse;
}

/** What the module needs from the SDK; a test hands in a stand-in. */
export interface ConversionSdk {
  quote(request: QuoteRequest, network: SupportedNetworks): Promise<QuoteResponse>;
  build(request: BuildQuoteRequest, network: SupportedNetworks): Promise<BuildQuoteResponse>;
}

export interface ConversionDeps {
  sdk: ConversionSdk | null;
  now: () => number;
}

function readEnv(): { apiKey: string | undefined; baseUrl: string | undefined; enabled: boolean } {
  return {
    apiKey: process.env.SOROSWAP_API_KEY?.trim() || undefined,
    baseUrl: process.env.SOROSWAP_API_URL?.trim() || undefined,
    enabled: process.env.SOROBAN_CONVERSION_ENABLED === "true",
  };
}

/** Whether the close may offer to convert a Soroban token at all: the flag is on and a key is set. */
export function isConversionEnabled(env = readEnv()): boolean {
  return env.enabled && env.apiKey !== undefined;
}

let cachedSdk: SoroswapSDK | null | undefined;
/** The environment the cached client was built from; a change rebuilds it rather than going stale. */
let cachedFrom = "";

/** The live SDK when conversion is enabled, else null (and every quote is "no route"). */
export function defaultConversionDeps(): ConversionDeps {
  const env = readEnv();
  const signature = `${env.enabled}|${env.apiKey ?? ""}|${env.baseUrl ?? ""}`;
  if (cachedSdk === undefined || cachedFrom !== signature) {
    cachedSdk =
      isConversionEnabled(env) && env.apiKey
        ? new SoroswapSDK({
            apiKey: env.apiKey,
            baseUrl: env.baseUrl,
            timeout: QUOTE_TIMEOUT_MS,
          })
        : null;
    cachedFrom = signature;
  }
  return { sdk: cachedSdk, now: () => Date.now() };
}

/** For tests and restarts: forget the SDK built from the environment. */
export function resetConversionSdk(): void {
  cachedSdk = undefined;
  cachedFrom = "";
}

const toSdkNetwork = (network: Network): SupportedNetworks =>
  network === "mainnet" ? SupportedNetworks.MAINNET : SupportedNetworks.TESTNET;

export function xlmContractId(network: Network): string {
  return Asset.native().contractId(NETWORK_PASSPHRASES[network]);
}

/** The floor under a quoted output: the quote less the slippage margin, never below one stroop. */
export function floorUnderQuote(amountOut: bigint): bigint {
  const min = (amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  return min > 0n ? min : 0n;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Quotes the whole balance of a token into XLM. Null when conversion is off, the API knows no
 * route, or the answer is not one a swap can be built from (no positive output, unknown platform).
 * Never throws: a quote that fails is a token that is not convertible right now, and the close
 * still offers transfer or leave.
 */
export async function quoteTokenToXlm(
  token: string,
  amountIn: bigint,
  network: Network,
  deps: ConversionDeps = defaultConversionDeps()
): Promise<TokenConversionQuote | null> {
  if (!deps.sdk || amountIn <= 0n) return null;
  const assetOut = xlmContractId(network);
  if (token === assetOut) return null;
  let raw: QuoteResponse;
  try {
    raw = await deps.sdk.quote(
      {
        assetIn: token,
        assetOut,
        amount: amountIn,
        tradeType: TradeType.EXACT_IN,
        protocols: CONVERSION_PROTOCOLS,
        slippageBps: SLIPPAGE_BPS,
      },
      toSdkNetwork(network)
    );
  } catch {
    return null;
  }
  const amountOut = asBigInt(raw.amountOut);
  const quotedIn = asBigInt(raw.amountIn);
  if (amountOut === null || amountOut <= 0n || quotedIn !== amountIn) return null;
  if (raw.assetIn !== token || raw.assetOut !== assetOut) return null;
  // Only the two Soroban shapes can be built and verified as a swap of this token; a classic
  // path payment (`sdex`) is not a conversion of a Soroban token at all.
  const platform = raw.platform;
  if (platform !== "aggregator" && platform !== "router") return null;
  const minAmountOut = floorUnderQuote(amountOut);
  if (minAmountOut <= 0n) return null;
  return {
    token,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minAmountOut: minAmountOut.toString(),
    platform,
    route: [
      ...new Set((raw.routePlan ?? []).map((r) => String(r.swapInfo?.protocol ?? ""))),
    ].filter((p) => p.length > 0),
    raw,
  };
}

/**
 * Asks the API to build the swap for a quote, as the account. Returns the unsigned XDR exactly as
 * the API produced it; the caller decodes and asserts it before anything else happens to it.
 */
export async function buildTokenConversion(
  quote: TokenConversionQuote,
  from: string,
  network: Network,
  deps: ConversionDeps = defaultConversionDeps()
): Promise<string | null> {
  if (!deps.sdk) return null;
  try {
    const built = await deps.sdk.build({ quote: quote.raw, from, to: from }, toSdkNetwork(network));
    return typeof built.xdr === "string" && built.xdr.length > 0 ? built.xdr : null;
  } catch {
    return null;
  }
}
