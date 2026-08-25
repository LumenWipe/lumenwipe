import "server-only";
import { kv } from "@vercel/kv";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

// Per-IP daily limiter for the playground's public routes.
//
// Deliberately a copy of apps/web/lib/rate-limit.ts + the counter half of apps/web/lib/kv.ts
// rather than an import: apps/playground never imports from apps/web (and vice versa), and it
// runs against its OWN Vercel KV store, so the two limiters share no counters even when they
// use the same namespace names.
//
// Both routes it guards spend real resources on an anonymous caller's behalf - one creates and
// Friendbot-funds a testnet account and writes a custodial session, the other decrypts and
// hands back a secret key - so neither can be left unbounded.

/** Session creations per IP per day. Matches the pre-rebuild playground's own limit. */
export const SESSIONS_PER_DAY_PER_IP = 25;
/** Credential reveals per IP per day. Higher: it is a read of a session the caller already has. */
export const CREDENTIALS_PER_DAY_PER_IP = 50;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// One-way, so no raw IP is ever written to KV.
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function clientIp(req: NextRequest): string {
  // Prefer x-real-ip: on Vercel it's the platform-set, trusted single client IP. The leftmost
  // x-forwarded-for entry can be client-spoofed behind proxies that append rather than
  // overwrite, which would let a caller rotate buckets to dodge the limit. Same ordering as
  // apps/web's limiter.
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

/**
 * Increments this IP's daily counter for `namespace` and reports whether it is still within
 * `limitPerDay`. Fails open on any KV trouble - a limiter outage must not take the playground
 * down - and is a no-op when KV is unconfigured, matching the session store's dev fallback
 * (production has no such fallback: it refuses to run without KV).
 */
async function withinLimit(namespace: string, ip: string, limitPerDay: number): Promise<boolean> {
  if (!isKvConfigured()) return true;
  try {
    const key = `playground:${namespace}:ratelimit:${hashIp(ip)}:${new Date().toISOString().slice(0, 10)}`;
    const pipeline = kv.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 86_400);
    const [rawCount] = await pipeline.exec();
    const count = typeof rawCount === "number" ? rawCount : limitPerDay + 1;
    return count <= limitPerDay;
  } catch (err) {
    console.error(`[playground] rate-limit check (${namespace}) failed, allowing request:`, err);
    return true;
  }
}

/**
 * Returns a 429 response when this request is over the limit, or null to let it proceed.
 * The error shape matches the app's other machine-readable route errors.
 */
export async function rateLimit(
  req: NextRequest,
  namespace: string,
  limitPerDay: number
): Promise<NextResponse | null> {
  if (await withinLimit(namespace, clientIp(req), limitPerDay)) return null;
  return NextResponse.json({ error: "rate_limited" }, { status: 429 });
}
