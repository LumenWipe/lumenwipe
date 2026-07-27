import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { checkNamespacedRateLimit } from "@/lib/kv";

// Generous for a legitimate close flow (a close is a handful of requests), but caps how
// much any single IP can pump through LumenWipe's shared API key in a day.
const PROXY_LIMIT_PER_DAY = 500;

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
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
  const allowed = await checkNamespacedRateLimit(
    `proxy:${namespace}`,
    clientIp(req),
    PROXY_LIMIT_PER_DAY
  );
  if (allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again later." },
    { status: 429 }
  );
}
