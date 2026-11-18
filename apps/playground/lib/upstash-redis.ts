import "server-only";
import { Redis } from "@upstash/redis";

let client: Redis | undefined;
let limiterClient: Redis | undefined;

export function isRedisConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

export function redis(): Redis {
  return (client ??= Redis.fromEnv());
}

/**
 * The rate limiter's own client: one attempt, no retries, as apps/web's limiter has it. The
 * client's default (five retries with exponential backoff) could hold a request for seconds
 * against a struggling backend before the limiter's fail-open path lets it through. The session
 * store keeps `redis()` and its defaults.
 */
export function limiterRedis(): Redis {
  return (limiterClient ??= Redis.fromEnv({ retry: { retries: 0 } }));
}
