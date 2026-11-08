import { Redis } from "@upstash/redis";
import { createHash } from "crypto";

// {namespace}:ratelimit:{ipHash}:{date} → per-IP daily request counter

/**
 * What the limiter says about one request:
 * - `allowed` / `limited`: the counter answered, under or over the limit.
 * - `unavailable`: the counter could not be asked (an error, a timeout, a reply it can't read, or
 *   no credentials on a deployment). Each route decides whether that lets the request through.
 * - `disabled`: no credentials outside a Vercel deployment (local dev, CI), so nothing is counted.
 */
export type RateLimitVerdict = "allowed" | "limited" | "unavailable" | "disabled";

/** How long a request waits on the counter before the limiter counts as unavailable. */
export const LIMITER_TIMEOUT_MS = 1000;

let client: { url: string; redis: Redis } | undefined;
let warnedDisabled = false;
let reportedUnconfigured = false;

function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
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

function hashIp(ip: string): string {
  // One-way hash so no raw IP is stored in Redis
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** One log line per failure: the namespace, the kind and at most the error's name. Never the IP,
 *  its hash, the key or the error's message, which may echo the command and its key. */
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
 */
export async function checkNamespacedRateLimit(
  namespace: string,
  ip: string,
  limitPerDay: number,
  options: { timeoutMs?: number } = {}
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
      console.warn("Rate limiting is disabled: Upstash Redis is not configured (local or CI).");
    }
    return "disabled";
  }

  try {
    const key = `${namespace}:ratelimit:${hashIp(ip)}:${new Date().toISOString().slice(0, 10)}`;
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
