import { Redis } from "@upstash/redis";
import { createHmac } from "crypto";
import { utcDayKey } from "@/lib/utc-day";

// {namespace}:ratelimit:{ipHash}:{date} → per-IP daily request counter. The UTC date in the key is
// what resets the counter at 00:00 UTC; the 24-hour expiry, renewed on each increment, only clears
// the previous day's key. {ipHash} is keyed with RATE_LIMIT_HASH_KEY over the namespace, the date
// and the IP, so it can't be reversed by enumerating addresses and links no two days or routes.

/**
 * What the limiter says about one request:
 * - `allowed` / `limited`: the counter answered, under or over the limit.
 * - `unavailable`: the counter could not be asked (an error, a timeout, a reply it can't read, or
 *   no credentials on a deployment). Each route decides whether that lets the request through.
 * - `disabled`: no credentials outside a Vercel deployment (local dev, CI), so nothing is counted.
 * Credentials are the Redis URL and token and a hash key of at least `MIN_HASH_KEY_LENGTH`.
 */
export type RateLimitVerdict = "allowed" | "limited" | "unavailable" | "disabled";

/** How long a request waits on the counter before the limiter counts as unavailable. */
export const LIMITER_TIMEOUT_MS = 1000;

/** The shortest `RATE_LIMIT_HASH_KEY` accepted; a shorter one counts as unset. */
export const MIN_HASH_KEY_LENGTH = 32;

let client: { url: string; redis: Redis } | undefined;
let warnedDisabled = false;
let reportedUnconfigured = false;

function credentials(): { url: string; token: string; hashKey: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const hashKey = process.env.RATE_LIMIT_HASH_KEY;
  if (!url || !token || !hashKey || hashKey.length < MIN_HASH_KEY_LENGTH) return null;
  return { url, token, hashKey };
}

/** A Vercel production or preview deployment: both spend the shared API key. `vercel dev` is not. */
function isDeployed(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview";
}

function redis(url: string, token: string): Redis {
  // One attempt, no retries: the client's default (five, with exponential backoff) could hold a
  // request for seconds against a struggling backend. The timeout below bounds the wait anyway.
  if (client?.url !== url) {
    client = { url, redis: new Redis({ url, token, retry: { retries: 0 } }) };
  }
  return client.redis;
}

function hashIp(hashKey: string, namespace: string, day: string, ip: string): string {
  return createHmac("sha256", hashKey)
    .update(`${namespace}:${day}:${ip}`)
    .digest("hex")
    .slice(0, 16);
}

/** One log line per failure: the namespace, the kind and at most the error's name. Never the IP,
 *  its hash, the counter key, the hash key or the error's message, which may echo the command and
 *  its key. */
function reportUnavailable(namespace: string, kind: string, err?: unknown): void {
  const name = err instanceof Error ? ` (${err.name})` : "";
  console.error(`Rate limiter unavailable for ${namespace}: ${kind}${name}`);
}

class LimiterTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LimiterTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Increments this IP's daily counter in `namespace` and judges it against `limitPerDay`. Never
 * throws: a failure to count is reported as `unavailable`, and the caller decides what that means.
 * `now` picks the UTC day counted against, so a caller can answer with the same day's reset.
 */
export async function checkNamespacedRateLimit(
  namespace: string,
  ip: string,
  limitPerDay: number,
  options: { timeoutMs?: number; now?: Date } = {}
): Promise<RateLimitVerdict> {
  const creds = credentials();
  if (!creds) {
    if (isDeployed()) {
      if (!reportedUnconfigured) {
        reportedUnconfigured = true;
        reportUnavailable(namespace, "unconfigured");
      }
      return "unavailable";
    }
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        "Rate limiting is disabled: Upstash Redis or its hash key is not configured (local or CI)."
      );
    }
    return "disabled";
  }

  try {
    const day = utcDayKey(options.now ?? new Date());
    const key = `${namespace}:ratelimit:${hashIp(creds.hashKey, namespace, day, ip)}:${day}`;
    const pipeline = redis(creds.url, creds.token).pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 86_400);
    const [count] = await withTimeout(pipeline.exec(), options.timeoutMs ?? LIMITER_TIMEOUT_MS);
    if (typeof count !== "number") {
      reportUnavailable(namespace, "bad_reply");
      return "unavailable";
    }
    return count <= limitPerDay ? "allowed" : "limited";
  } catch (err) {
    if (err instanceof LimiterTimeout) reportUnavailable(namespace, "timeout");
    else reportUnavailable(namespace, "error", err);
    return "unavailable";
  }
}
