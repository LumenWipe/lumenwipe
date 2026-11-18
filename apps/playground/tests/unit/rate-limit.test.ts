import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createRateLimiter,
  MIN_HASH_KEY_LENGTH,
  type DailyCounter,
  type RateLimiterDeps,
} from "@/lib/rate-limit";

const IP = "203.0.113.7";
const PLAIN_IP_HASH = createHash("sha256").update(IP).digest("hex").slice(0, 16);
// Generated per run: no key-shaped value is ever written into the repository.
const HASH_KEY = randomBytes(32).toString("hex");

function ipHash(namespace: string, day: string, key = HASH_KEY): string {
  return createHmac("sha256", key)
    .update(`playground:${namespace}:${day}:${IP}`)
    .digest("hex")
    .slice(0, 16);
}

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

function limiter(counter: DailyCounter | null, deps: Partial<RateLimiterDeps> = {}) {
  return createRateLimiter({
    counter: () => counter,
    today,
    hashKey: () => HASH_KEY,
    deployed: () => true,
    ...deps,
  });
}

let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("rate limit", () => {
  test("requests up to the limit pass and the next one is a 429 rate_limited", async () => {
    const { counter, ttls } = memoryCounter();
    const limit = limiter(counter);
    const req = request({ "x-real-ip": IP });
    expect(await limit(req, "session", 2)).toBeNull();
    expect(await limit(req, "session", 2)).toBeNull();
    const refused = await limit(req, "session", 2);
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ error: "rate_limited" });
    expect(ttls).toEqual([86_400, 86_400, 86_400]);
  });

  test("counters are per namespace and per day, keyed by the hmac of the route, the day and the ip", async () => {
    const { counter, keys } = memoryCounter();
    const limit = limiter(counter);
    const req = request({ "x-real-ip": IP });
    await limit(req, "session", 1);
    expect(await limit(req, "credentials", 1)).toBeNull();
    expect(keys).toEqual([
      `playground:session:ratelimit:${ipHash("session", "2026-11-09")}:2026-11-09`,
      `playground:credentials:ratelimit:${ipHash("credentials", "2026-11-09")}:2026-11-09`,
    ]);
    for (const key of keys) {
      expect(key).not.toContain(IP);
      expect(key).not.toContain(PLAIN_IP_HASH);
    }
  });

  test("the hash changes with the key, the day and the namespace", async () => {
    const other = randomBytes(32).toString("hex");
    const hashes = new Set<string>();
    for (const [key, namespace, day] of [
      [HASH_KEY, "t", "2026-11-08"],
      [other, "t", "2026-11-08"],
      [HASH_KEY, "t", "2026-11-09"],
      [HASH_KEY, "u", "2026-11-08"],
    ] as const) {
      const { counter, keys } = memoryCounter();
      await limiter(counter, { hashKey: () => key, today: () => day })(
        request({ "x-real-ip": IP }),
        namespace,
        5
      );
      const match = /^playground:[a-z]+:ratelimit:([0-9a-f]{16}):\d{4}-\d{2}-\d{2}$/.exec(keys[0]!);
      expect(match).not.toBeNull();
      hashes.add(match![1]!);
    }
    expect(hashes.size).toBe(4);
  });

  for (const [label, key] of [
    ["unset", undefined],
    ["empty", ""],
    ["one character short", "k".repeat(MIN_HASH_KEY_LENGTH - 1)],
  ] as const) {
    test(`a deployment with the hash key ${label} counts nothing, lets requests through and reports it once`, async () => {
      const { counter, keys } = memoryCounter();
      const limit = limiter(counter, { hashKey: () => key });
      const req = request({ "x-real-ip": IP });
      for (let i = 0; i < 3; i++) expect(await limit(req, "session", 1)).toBeNull();
      expect(keys).toEqual([]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain("RATE_LIMIT_HASH_KEY");
      expect(warnSpy).not.toHaveBeenCalled();
    });
  }

  test("outside a deployment a missing hash key disables the limiter with one warning", async () => {
    const { counter, keys } = memoryCounter();
    const limit = limiter(counter, { hashKey: () => undefined, deployed: () => false });
    const req = request({ "x-real-ip": IP });
    for (let i = 0; i < 3; i++) expect(await limit(req, "session", 1)).toBeNull();
    expect(keys).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("a hash key of exactly the minimum length is used", async () => {
    const key = randomBytes(MIN_HASH_KEY_LENGTH / 2).toString("hex");
    const { counter, keys } = memoryCounter();
    const limit = limiter(counter, { hashKey: () => key });
    expect(await limit(request({ "x-real-ip": IP }), "session", 1)).toBeNull();
    expect((await limit(request({ "x-real-ip": IP }), "session", 1))?.status).toBe(429);
    expect(keys[0]).toBe(
      `playground:session:ratelimit:${ipHash("session", "2026-11-09", key)}:2026-11-09`
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("x-real-ip wins over a spoofable x-forwarded-for", async () => {
    const { counter, keys } = memoryCounter();
    const limit = limiter(counter);
    await limit(request({ "x-real-ip": IP, "x-forwarded-for": "198.51.100.1" }), "s", 9);
    await limit(request({ "x-real-ip": IP, "x-forwarded-for": "198.51.100.2" }), "s", 9);
    expect(keys[0]).toBe(keys[1]!);
  });

  test("without x-real-ip the first x-forwarded-for entry is the client", async () => {
    const { counter, keys } = memoryCounter();
    const limit = limiter(counter);
    await limit(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), "s", 9);
    await limit(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), "s", 9);
    await limit(request({ "x-forwarded-for": "198.51.100.3, 10.0.0.1" }), "s", 9);
    expect(keys[0]).toBe(keys[1]!);
    expect(keys[2]).not.toBe(keys[0]!);
  });

  test("a counter failure lets the request through and logs only the namespace and the error's name", async () => {
    const { counter: inner, keys } = memoryCounter();
    const limit = limiter(async (key, ttl) => {
      await inner(key, ttl);
      throw new TypeError(`ECONNRESET on INCR ${key}`);
    });
    expect(await limit(request({ "x-real-ip": IP }), "session", 1)).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]!.map(String);
    expect(logged).toContain("session");
    expect(logged).toContain("TypeError");
    for (const arg of logged) {
      for (const leak of [IP, keys[0]!, ipHash("session", "2026-11-09"), HASH_KEY, "ECONNRESET"]) {
        expect(arg).not.toContain(leak);
      }
    }
  });

  test("a count that is not a number is treated as over the limit", async () => {
    const limit = limiter(async () => "OK");
    expect((await limit(request({ "x-real-ip": IP }), "session", 5))?.status).toBe(429);
  });

  test("with no counter configured every request passes", async () => {
    const limit = limiter(null);
    const req = request({ "x-real-ip": IP });
    for (let i = 0; i < 5; i++) expect(await limit(req, "session", 1)).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
