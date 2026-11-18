import "server-only";
import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isDeployedEnv } from "./session-store";
import { isRedisConfigured, redis } from "./upstash-redis";

// Per-IP daily limiter for the playground's public routes.
//
// Deliberately a copy of the counter half of apps/web/lib/upstash-redis.ts, keyed hash included,
// rather than an import: apps/playground never imports from apps/web (and vice versa), and it
// keys every counter, and every hashed message, under a `playground:` prefix, so the two limiters
// share no counters even when they use the same namespace names. Each app's test recomputes its
// HMAC over the exact message, so a change to either construction fails there.
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
/** Receipt reads per IP per day: one per close transaction, with room for retries while the
 *  network catches up, across every close the session limit allows. */
export const RECEIPTS_PER_DAY_PER_IP = 500;

/** The shortest `RATE_LIMIT_HASH_KEY` accepted; a shorter one counts as unset. */
export const MIN_HASH_KEY_LENGTH = 32;

// Keyed, so no raw IP is ever written to Redis and the hash cannot be reversed by enumerating
// addresses; the namespace and the UTC day in the message link no two routes or days.
function hashIp(hashKey: string, namespace: string, day: string, ip: string): string {
  return createHmac("sha256", hashKey)
    .update(`playground:${namespace}:${day}:${ip}`)
    .digest("hex")
    .slice(0, 16);
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
  /** The key of the IP hash, `RATE_LIMIT_HASH_KEY`. */
  hashKey: () => string | undefined;
  /** Whether this process is a deployment, where a missing hash key is an error, not a warning. */
  deployed: () => boolean;
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
 * without Redis). Without a hash key of at least `MIN_HASH_KEY_LENGTH` it counts nothing either:
 * on a deployment that is reported once as unavailable, elsewhere warned once as disabled.
 */
export function createRateLimiter(deps: RateLimiterDeps): RateLimit {
  let reportedUnconfigured = false;

  function usableHashKey(): string | null {
    const hashKey = deps.hashKey();
    if (hashKey && hashKey.length >= MIN_HASH_KEY_LENGTH) return hashKey;
    if (!reportedUnconfigured) {
      reportedUnconfigured = true;
      if (deps.deployed()) {
        console.error(
          "[playground] Rate limiter unavailable: RATE_LIMIT_HASH_KEY is unset or too short, allowing requests"
        );
      } else {
        console.warn(
          "[playground] Rate limiting is disabled: RATE_LIMIT_HASH_KEY is not configured (local or CI)"
        );
      }
    }
    return null;
  }

  async function withinLimit(namespace: string, ip: string, limitPerDay: number): Promise<boolean> {
    const counter = deps.counter();
    if (!counter) return true;
    const hashKey = usableHashKey();
    if (!hashKey) return true;
    try {
      const day = deps.today();
      const key = `playground:${namespace}:ratelimit:${hashIp(hashKey, namespace, day, ip)}:${day}`;
      const rawCount = await counter(key, 86_400);
      const count = typeof rawCount === "number" ? rawCount : limitPerDay + 1;
      return count <= limitPerDay;
    } catch (err) {
      // The namespace and the error's name only: its message may echo the command and its key.
      console.error(
        "[playground] Rate-limit check failed, allowing request:",
        namespace,
        err instanceof Error ? err.name : "unknown"
      );
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
  hashKey: () => process.env.RATE_LIMIT_HASH_KEY,
  deployed: () => isDeployedEnv(process.env),
});
