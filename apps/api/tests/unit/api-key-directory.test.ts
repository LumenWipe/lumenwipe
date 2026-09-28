import { test, expect } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { ApiKeyService } from "@/auth/api-key.service";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { InMemoryApiKeyStore } from "@/auth/api-key-store";

function staticKeys(apiKeys: string): ApiKeyService {
  return new ApiKeyService({ get: () => apiKeys } as unknown as ConfigService);
}

test("resolves a static (env-provisioned) key without touching the store", async () => {
  let storeCalls = 0;
  const store = new InMemoryApiKeyStore();
  const originalResolve = store.resolve.bind(store);
  store.resolve = async (key: string) => {
    storeCalls++;
    return originalResolve(key);
  };

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store);
  const resolved = await directory.resolve("key_abc");

  expect(resolved).toEqual({ label: "web", rateLimit: null });
  expect(storeCalls).toBe(0);
});

test("falls back to the store for a key the static map doesn't know", async () => {
  const store = new InMemoryApiKeyStore();
  const { raw } = await store.create("polar", { limit: 5, ttlMs: 1000 });

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store);
  const resolved = await directory.resolve(raw);

  expect(resolved).toEqual({ label: "polar", rateLimit: { limit: 5, ttlMs: 1000 } });
});

test("an unknown key (neither static nor in the store) resolves to null", async () => {
  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), new InMemoryApiKeyStore());
  expect(await directory.resolve("nope")).toBeNull();
});

test("a revoked self-serve key resolves to null", async () => {
  const store = new InMemoryApiKeyStore();
  const { raw, record } = await store.create("polar");
  await store.revoke(record.hash);

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store);
  expect(await directory.resolve(raw)).toBeNull();
});

test("caches a store resolution so a second lookup within the TTL costs no extra store call", async () => {
  const store = new InMemoryApiKeyStore();
  const { raw } = await store.create("polar");
  let storeCalls = 0;
  const originalResolve = store.resolve.bind(store);
  store.resolve = async (key: string) => {
    storeCalls++;
    return originalResolve(key);
  };

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store, 10_000);
  await directory.resolve(raw);
  await directory.resolve(raw);

  expect(storeCalls).toBe(1);
});

test("re-queries the store once the cache entry expires", async () => {
  const store = new InMemoryApiKeyStore();
  const { raw } = await store.create("polar");
  let storeCalls = 0;
  const originalResolve = store.resolve.bind(store);
  store.resolve = async (key: string) => {
    storeCalls++;
    return originalResolve(key);
  };

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store, 1);
  await directory.resolve(raw);
  await Bun.sleep(5);
  await directory.resolve(raw);

  expect(storeCalls).toBe(2);
});

test("invalidate drops a cached positive resolution, forcing a fresh store read on revoke", async () => {
  const store = new InMemoryApiKeyStore();
  const { raw, record } = await store.create("polar");

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store, 60_000);
  expect(await directory.resolve(raw)).toEqual({ label: "polar", rateLimit: null });

  await store.revoke(record.hash);
  // Still cached as valid, within the TTL - proves the cache is the reason invalidate matters.
  expect(await directory.resolve(raw)).toEqual({ label: "polar", rateLimit: null });

  directory.invalidate(record.hash);
  expect(await directory.resolve(raw)).toBeNull();
});

test("negative results are cached too, so repeated bad keys don't hammer the store", async () => {
  const store = new InMemoryApiKeyStore();
  let storeCalls = 0;
  const originalResolve = store.resolve.bind(store);
  store.resolve = async (key: string) => {
    storeCalls++;
    return originalResolve(key);
  };

  const directory = new ApiKeyDirectory(staticKeys("web=key_abc"), store, 10_000);
  await directory.resolve("garbage");
  await directory.resolve("garbage");

  expect(storeCalls).toBe(1);
});
