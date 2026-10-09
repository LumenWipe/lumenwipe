import "server-only";
import { Redis } from "@upstash/redis";

let client: Redis | undefined;

export function isRedisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export function redis(): Redis {
  return (client ??= Redis.fromEnv());
}
