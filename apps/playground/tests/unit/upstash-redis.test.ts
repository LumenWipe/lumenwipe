import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { limiterRedis, redis } from "@/lib/upstash-redis";

// The limiter's client makes one attempt; fetch is stubbed, so nothing reaches the network.

const ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.UPSTASH_REDIS_REST_URL = "https://limiter.redis.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const failing = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(failing, { preconnect: () => {} })
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("the limiter's client gives up after one failed attempt", async () => {
  const pipeline = limiterRedis().pipeline();
  pipeline.incr("playground:t:ratelimit:k:2026-11-09");
  pipeline.expire("playground:t:ratelimit:k:2026-11-09", 86_400);
  await expect(pipeline.exec()).rejects.toThrow();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("the session store keeps a client of its own", () => {
  expect(limiterRedis()).not.toBe(redis());
});
