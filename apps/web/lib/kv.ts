import { kv } from "@vercel/kv";
import { createHash } from "crypto";

// {namespace}:ratelimit:{ipHash}:{date} → per-IP daily request counter

function hashIp(ip: string): string {
  // One-way hash so no raw IP is stored in Redis
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Increments this IP's daily counter in `namespace` and returns whether it is within
 * `limitPerDay`. Fails open: if KV is unavailable the request is allowed through.
 */
export async function checkNamespacedRateLimit(
  namespace: string,
  ip: string,
  limitPerDay: number
): Promise<boolean> {
  try {
    const key = `${namespace}:ratelimit:${hashIp(ip)}:${new Date().toISOString().slice(0, 10)}`;
    const pipeline = kv.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 86_400);
    const [rawCount] = await pipeline.exec();
    const count = typeof rawCount === "number" ? rawCount : limitPerDay + 1;
    return count <= limitPerDay;
  } catch (err) {
    console.error(`Rate-limit check (${namespace}) failed, allowing request:`, err);
    return true;
  }
}
