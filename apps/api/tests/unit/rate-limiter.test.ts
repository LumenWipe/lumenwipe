import { describe, expect, test } from "bun:test";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { RateLimiter, isUnthrottledPath } from "@/auth/rate-limiter";
import type { ApiKeyDirectory } from "@/auth/api-key-directory";

function limiter(
  rateLimit: { limit: number; ttlMs: number } | null = null,
  defaults = { limit: 3, ttl: 60_000 }
): RateLimiter {
  const directory = {
    resolve: async () => (rateLimit ? { label: "k", rateLimit } : null),
  } as unknown as ApiKeyDirectory;
  return new RateLimiter([defaults], new ThrottlerStorageService(), directory);
}

const request = (key: string): Record<string, unknown> => ({
  headers: { authorization: `Bearer ${key}` },
});

describe("RateLimiter", () => {
  test("reports the limit and a decreasing remaining count, then blocks", async () => {
    const rl = limiter();
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(await rl.consume(request("a")));
    expect(seen.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    expect(seen.map((d) => d.blocked)).toEqual([false, false, false, true]);
    expect(seen[0]!.limit).toBe(3);
    expect(seen[3]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(seen[3]!.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test("a key's own override replaces the default limit and window", async () => {
    const rl = limiter({ limit: 1, ttlMs: 600_000 });
    const first = await rl.consume(request("b"));
    const second = await rl.consume(request("b"));
    expect(first.limit).toBe(1);
    expect(first.resetSeconds).toBeGreaterThan(60);
    expect(second.blocked).toBe(true);
  });

  test("a blocked override key is released after the global block window, and Retry-After says so", async () => {
    // Evidence for leaving blockDuration alone for override keys: the storage resets a blocked
    // key's count when its block ends, so the block length is what Retry-After reports.
    const rl = limiter({ limit: 1, ttlMs: 600_000 }, { limit: 3, ttl: 1_000 });
    await rl.consume(request("c"));
    const blocked = await rl.consume(request("c"));
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSeconds).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const served = await rl.consume(request("c"));
    expect(served.blocked).toBe(false);
  });

  test("keys and clients without a key have separate budgets", async () => {
    const rl = limiter();
    for (let i = 0; i < 4; i++) await rl.consume(request("d"));
    expect((await rl.consume(request("e"))).blocked).toBe(false);
    expect((await rl.consume({ headers: {}, ip: "203.0.113.5" })).blocked).toBe(false);
  });
});

describe("isUnthrottledPath", () => {
  test.each(["/", "/health", "/health/deep", "/docs", "/docs/", "/docs-json"])(
    "%s is not counted",
    (path) => expect(isUnthrottledPath(path)).toBe(true)
  );
  test.each([
    "/v1/testnet/stats",
    "/testnet/account/G",
    "/config/exchange-registry",
    "/nope",
    "/healthz",
    "/docsx",
    "/integrator/keys",
  ])("%s is counted", (path) => expect(isUnthrottledPath(path)).toBe(false));
});
