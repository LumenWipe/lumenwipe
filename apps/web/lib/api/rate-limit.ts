import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { checkNamespacedRateLimit } from "@/lib/kv";

// Generous for a legitimate close flow (a close is a handful of requests), but caps how
// much any single IP can pump through LumenWipe's shared API key in a day.
const PROXY_LIMIT_PER_DAY = 500;

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

/**
 * Per-IP daily rate limit for the key-injecting proxy routes. The browser reaches these
 * routes with no API key, so without this a single client could turn the proxy into an
 * anonymous amplifier against the shared server-side key. Returns a 429 response when the
 * caller is over the limit, or null to proceed. Fails open (a KV outage allows the request)
 * so infrastructure trouble never blocks a legitimate, irreversible close.
 */
export async function rateLimitProxy(
  req: NextRequest,
  namespace: string
): Promise<NextResponse | null> {
  let allowed = true;
  try {
    allowed = await checkNamespacedRateLimit(
      `proxy:${namespace}`,
      clientIp(req),
      PROXY_LIMIT_PER_DAY
    );
  } catch {
    // Fail open - limiter trouble must never block a legitimate, irreversible close.
    return null;
  }
  if (allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again later." },
    { status: 429 }
  );
}
