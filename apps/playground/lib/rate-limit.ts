import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isRedisConfigured, redis } from "./upstash-redis";

// Per-IP daily limiter for the playground's public routes.
//
// Deliberately a copy of apps/web/lib/rate-limit.ts + the counter half of apps/web/lib/upstash-redis.ts
// rather than an import: apps/playground never imports from apps/web (and vice versa), and it
// keys every counter under a `playground:` prefix, so the two limiters share no counters even
// when they use the same namespace names.
//
// The routes it guards spend real resources on an anonymous caller's behalf - a start creates
// and funds testnet accounts and writes custodial sessions, a credential reveal decrypts and hands
// back a secret key, and a batch plan spends the playground's API key - so none can be left
// unbounded.

/** Session creations per IP per day. Matches the pre-rebuild playground's own limit. */
export const SESSIONS_PER_DAY_PER_IP = 25;
/** Credential reveals per IP per day. Higher: it is a read of a session the caller already has. */
export const CREDENTIALS_PER_DAY_PER_IP = 50;
/** Batch plans per IP per day. Each one spends the playground's API key on every member's read;
 *  a batch needs one, so this leaves room for retries across the batches the session limit allows. */
export const BATCH_PLANS_PER_DAY_PER_IP = 50;

// One-way, so no raw IP is ever written to Redis.
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

/** Increments `key`, sets it to expire after `ttlSeconds`, and resolves to the new count. */
export type DailyCounter = (key: string, ttlSeconds: number) => Promise<unknown>;

export interface RateLimiterDeps {
  /** The counter to use, or null when no store is configured (the limiter then allows everything). */
  counter: () => DailyCounter | null;
  /** The UTC day the counters are bucketed by, as YYYY-MM-DD. */
  today: () => string;
}

export type RateLimit = (
  req: NextRequest,
  namespace: string,
  limitPerDay: number
) => Promise<NextResponse | null>;

/**
 * Builds the limiter over an injected counter. It fails open on any counter trouble - a limiter
 * outage must not take the playground down - and is a no-op when no counter is configured,
 * matching the session store's dev fallback (production has no such fallback: it refuses to run
 * without Redis).
 */
export function createRateLimiter(deps: RateLimiterDeps): RateLimit {
  async function withinLimit(namespace: string, ip: string, limitPerDay: number): Promise<boolean> {
    const counter = deps.counter();
    if (!counter) return true;
    try {
      const key = `playground:${namespace}:ratelimit:${hashIp(ip)}:${deps.today()}`;
      const rawCount = await counter(key, 86_400);
      const count = typeof rawCount === "number" ? rawCount : limitPerDay + 1;
      return count <= limitPerDay;
    } catch (err) {
      console.error(`[playground] rate-limit check (${namespace}) failed, allowing request:`, err);
      return true;
    }
  }

  // Returns a 429 response when this request is over the limit, or null to let it proceed. The
  // error shape matches the app's other machine-readable route errors.
  return async (req, namespace, limitPerDay) => {
    if (await withinLimit(namespace, clientIp(req), limitPerDay)) return null;
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  };
}

const upstashCounter: DailyCounter = async (key, ttlSeconds) => {
  const pipeline = redis().pipeline();
  pipeline.incr(key);
  pipeline.expire(key, ttlSeconds);
  const [rawCount] = await pipeline.exec();
  return rawCount;
};

export const rateLimit: RateLimit = createRateLimiter({
  counter: () => (isRedisConfigured() ? upstashCounter : null),
  today: () => new Date().toISOString().slice(0, 10),
});
