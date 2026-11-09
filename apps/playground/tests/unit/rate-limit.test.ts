import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { createRateLimiter, type DailyCounter } from "@/lib/rate-limit";

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL("/api/session", "http://localhost:3002"), {
    method: "POST",
    headers,
  });
}

/** An in-memory counter that records every key it is asked to increment. */
function memoryCounter(): { counter: DailyCounter; keys: string[]; ttls: number[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const ttls: number[] = [];
  return {
    keys,
    ttls,
    counter: async (key, ttlSeconds) => {
      keys.push(key);
      ttls.push(ttlSeconds);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

const today = () => "2026-11-09";

describe("rate limit", () => {
  test("requests up to the limit pass and the next one is a 429 rate_limited", async () => {
    const { counter, ttls } = memoryCounter();
    const limit = createRateLimiter({ counter: () => counter, today });
    const req = request({ "x-real-ip": "203.0.113.7" });
    expect(await limit(req, "session", 2)).toBeNull();
    expect(await limit(req, "session", 2)).toBeNull();
    const refused = await limit(req, "session", 2);
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ error: "rate_limited" });
    expect(ttls).toEqual([86_400, 86_400, 86_400]);
  });

  test("counters are per namespace, per day and keyed by a hash, never the raw address", async () => {
    const { counter, keys } = memoryCounter();
    const limit = createRateLimiter({ counter: () => counter, today });
    const req = request({ "x-real-ip": "203.0.113.7" });
    await limit(req, "session", 1);
    expect(await limit(req, "credentials", 1)).toBeNull();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toStartWith("playground:session:ratelimit:");
    expect(keys[0]).toEndWith(":2026-11-09");
    expect(keys[1]).toStartWith("playground:credentials:ratelimit:");
    for (const key of keys) expect(key).not.toContain("203.0.113.7");
  });

  test("x-real-ip wins over a spoofable x-forwarded-for", async () => {
    const { counter, keys } = memoryCounter();
    const limit = createRateLimiter({ counter: () => counter, today });
    await limit(request({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), "s", 9);
    await limit(request({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.2" }), "s", 9);
    expect(keys[0]).toBe(keys[1]!);
  });

  test("without x-real-ip the first x-forwarded-for entry is the client", async () => {
    const { counter, keys } = memoryCounter();
    const limit = createRateLimiter({ counter: () => counter, today });
    await limit(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), "s", 9);
    await limit(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), "s", 9);
    await limit(request({ "x-forwarded-for": "198.51.100.3, 10.0.0.1" }), "s", 9);
    expect(keys[0]).toBe(keys[1]!);
    expect(keys[2]).not.toBe(keys[0]!);
  });

  test("a counter failure lets the request through", async () => {
    const limit = createRateLimiter({
      counter: () => async () => {
        throw new Error("ECONNRESET");
      },
      today,
    });
    expect(await limit(request({ "x-real-ip": "203.0.113.7" }), "session", 1)).toBeNull();
  });

  test("a count that is not a number is treated as over the limit", async () => {
    const limit = createRateLimiter({ counter: () => async () => "OK", today });
    expect((await limit(request({ "x-real-ip": "203.0.113.7" }), "session", 5))?.status).toBe(429);
  });

  test("with no counter configured every request passes", async () => {
    const limit = createRateLimiter({ counter: () => null, today });
    const req = request({ "x-real-ip": "203.0.113.7" });
    for (let i = 0; i < 5; i++) expect(await limit(req, "session", 1)).toBeNull();
  });
});
