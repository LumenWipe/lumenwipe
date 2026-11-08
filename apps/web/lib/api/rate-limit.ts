import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { checkNamespacedRateLimit } from "@/lib/upstash-redis";
import { invalidNetworkResponse } from "@/lib/api/network-segment";
import { rateLimitedResponse, rateLimiterUnavailableResponse } from "@/lib/api/proxy-error";

// Generous for a legitimate close flow (a close is a handful of requests), but caps how
// much any single IP can pump through LumenWipe's shared API key in a day.
export const PROXY_LIMIT_PER_DAY = 500;

function clientIp(req: NextRequest): string {
  // Prefer x-real-ip: on Vercel it's the platform-set, trusted single client IP. The
  // leftmost x-forwarded-for entry can be client-spoofed behind proxies that append
  // rather than overwrite, which would let a caller rotate buckets to dodge the limit.
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export interface RateLimitOptions {
  /** A route with a `[network]` param passes it, so an unknown network gets its 400 uncounted. */
  params?: Promise<{ network: string }>;
  /** A route that costs more than one upstream read per request sets its own bucket size. */
  limitPerDay?: number;
  /**
   * What happens when the limiter can't be asked. `allow` (the default) lets the request through,
   * so limiter trouble never blocks a step of a legitimate, irreversible close. `refuse` answers
   * 503, for an optional route whose upstream cost per request is high enough that an outage of
   * the limiter must not turn into uncapped reads against the shared key.
   */
  whenUnavailable?: "allow" | "refuse";
}

/**
 * Per-IP daily rate limit for the key-injecting proxy routes. The browser reaches these
 * routes with no API key, so without this a single client could turn the proxy into an
 * anonymous amplifier against the shared server-side key. Returns a 429 response when the
 * caller is over the limit, a 503 when the limiter is unavailable and the route refuses in that
 * case, or null to proceed.
 */
export async function rateLimitProxy(
  req: NextRequest,
  namespace: string,
  { params, limitPerDay = PROXY_LIMIT_PER_DAY, whenUnavailable = "allow" }: RateLimitOptions = {}
): Promise<NextResponse | null> {
  if (params && !isValidNetwork((await params).network)) return invalidNetworkResponse();

  // One clock for the counter's day and the 429's Retry-After, so a request that crosses midnight
  // is never told to wait for a reset its own key has already had.
  const now = new Date();
  const verdict = await checkNamespacedRateLimit(`proxy:${namespace}`, clientIp(req), limitPerDay, {
    now,
  });
  if (verdict === "limited") return rateLimitedResponse(now);
  if (verdict === "unavailable" && whenUnavailable === "refuse") {
    return rateLimiterUnavailableResponse();
  }
  return null;
}
