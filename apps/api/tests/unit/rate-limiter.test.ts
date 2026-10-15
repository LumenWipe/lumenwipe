import { afterEach, describe, expect, spyOn, test, mock } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { ThrottlerStorageService } from "@nestjs/throttler";
import { RateLimiter, isUnthrottledPath } from "@/auth/rate-limiter";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { ApiKeyService } from "@/auth/api-key.service";
import { InMemoryApiKeyStore, generateApiKey } from "@/auth/api-key-store";

afterEach(() => {
  mock.restore();
});

function limiter(
  rateLimit: { limit: number; ttlMs: number } | null = null,
  defaults = { limit: 3, ttl: 60_000 }
): RateLimiter {
  const known = { label: "k", rateLimit };
  const directory = {
    peek: () => known,
    resolve: async () => known,
  } as unknown as ApiKeyDirectory;
  return new RateLimiter([defaults], new ThrottlerStorageService(), directory);
}

const request = (key: string, ip = "203.0.113.1"): Record<string, unknown> => ({
  headers: { authorization: `Bearer ${key}` },
  ip,
});

function realLimiter(limit = 3): {
  rl: RateLimiter;
  store: InMemoryApiKeyStore;
  storeResolve: ReturnType<typeof spyOn>;
} {
  const store = new InMemoryApiKeyStore();
  const storeResolve = spyOn(store, "resolve");
  const staticKeys = new ApiKeyService({
    get: () => "web=static_web_key",
  } as unknown as ConfigService);
  const directory = new ApiKeyDirectory(staticKeys, store);
  const rl = new RateLimiter([{ limit, ttl: 60_000 }], new ThrottlerStorageService(), directory);
  return { rl, store, storeResolve };
}

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

describe("RateLimiter with unauthenticated and unknown bearers", () => {
  test("invented bearers from one client share that client's IP budget", async () => {
    const { rl } = realLimiter(3);
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(await rl.consume(request(generateApiKey())));
    for (let i = 0; i < 2; i++) seen.push(await rl.consume(request(`not-a-key-${i}`)));
    seen.push(await rl.consume({ headers: {}, ip: "203.0.113.1" }));
    expect(seen.map((d) => d.blocked)).toEqual([false, false, false, true, true, true, true]);
  });

  test("once the client's lookup budget is spent, an unknown key costs no store read", async () => {
    const { rl, storeResolve } = realLimiter(2);
    await rl.consume(request(generateApiKey()));
    await rl.consume(request(generateApiKey()));
    expect(storeResolve).toHaveBeenCalledTimes(2);

    const blocked = await rl.consume(request(generateApiKey()));
    expect(blocked.blocked).toBe(true);
    expect(storeResolve).toHaveBeenCalledTimes(2);
  });

  test("a value without the key shape never reaches the store", async () => {
    const { rl, storeResolve } = realLimiter(5);
    await rl.consume(request("garbage"));
    await rl.consume(request(`lw_${"a".repeat(42)}`));
    expect(storeResolve).not.toHaveBeenCalled();
  });

  test("a store-backed key is counted against its own budget, not the client's", async () => {
    const { rl, store } = realLimiter(2);
    const { raw } = await store.create("polar", { limit: 5, ttlMs: 60_000 });
    const first = await rl.consume(request(raw));
    expect(first.limit).toBe(5);
    expect(first.remaining).toBe(4);
    for (let i = 0; i < 3; i++) await rl.consume(request(raw));
    expect((await rl.consume(request(raw))).blocked).toBe(false);
  });

  test("a known key keeps working after its client IP runs out of budget", async () => {
    const { rl, store } = realLimiter(2);
    const { raw } = await store.create("polar");
    await rl.consume(request(raw));
    for (let i = 0; i < 3; i++) await rl.consume(request("garbage"));
    expect((await rl.consume(request("garbage"))).blocked).toBe(true);
    expect((await rl.consume(request(raw))).blocked).toBe(false);
    expect((await rl.consume(request("static_web_key"))).blocked).toBe(false);
  });

  test("a store-backed key that is not cached yet is found while its client IP is blocked", async () => {
    const { rl, store } = realLimiter(2);
    const { raw } = await store.create("polar");
    for (let i = 0; i < 3; i++) await rl.consume(request("garbage"));
    expect((await rl.consume(request("garbage"))).blocked).toBe(true);
    const keyed = await rl.consume(request(raw));
    expect(keyed.blocked).toBe(false);
    expect(keyed.remaining).toBe(1);
  });

  test("a key found in the store is not also charged to the client", async () => {
    const { rl, store } = realLimiter(2);
    const { raw } = await store.create("polar");
    await rl.consume(request(raw));
    await rl.consume(request(raw));
    const anonymous = await rl.consume({ headers: {}, ip: "203.0.113.1" });
    expect(anonymous.remaining).toBe(1);
  });

  test("addresses in one IPv6 /64 share a budget", async () => {
    const { rl } = realLimiter(2);
    await rl.consume({ headers: {}, ip: "2001:db8:1:2::1" });
    await rl.consume({ headers: {}, ip: "2001:db8:1:2:ffff:ffff:ffff:fffe" });
    expect((await rl.consume({ headers: {}, ip: "2001:db8:1:2:abcd::9" })).blocked).toBe(true);
    expect((await rl.consume({ headers: {}, ip: "2001:db8:1:3::1" })).blocked).toBe(false);
  });

  test("a store failure leaves the request on its IP budget", async () => {
    const { rl, storeResolve } = realLimiter(1);
    storeResolve.mockImplementation(async () => {
      throw new Error("store down");
    });
    const first = await rl.consume(request(generateApiKey()));
    expect(first.blocked).toBe(false);
    expect((await rl.consume({ headers: {}, ip: "203.0.113.1" })).blocked).toBe(true);
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
