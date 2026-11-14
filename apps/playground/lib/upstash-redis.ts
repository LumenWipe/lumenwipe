import "server-only";
import { Redis } from "@upstash/redis";

let client: Redis | undefined;

export function isRedisConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

export function redis(): Redis {
  return (client ??= Redis.fromEnv());
}
