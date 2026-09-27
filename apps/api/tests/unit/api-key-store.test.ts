import { describe, expect, test } from "bun:test";
import { generateApiKey, hashApiKey, InMemoryApiKeyStore } from "@/auth/api-key-store";

// InMemoryApiKeyStore is the reference implementation of ApiKeyStore's contract - every
// automated test exercises it, never live Firestore (see api-key-store.ts's own docstring on
// createApiKeyStore). FirestoreApiKeyStore mirrors this exact contract against real documents.

describe("hashApiKey / generateApiKey", () => {
  test("generated keys are prefixed and high-entropy", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toStartWith("lw_");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });

  test("hashing is deterministic and never reproduces the raw key", () => {
    const raw = generateApiKey();
    const hash = hashApiKey(raw);
    expect(hashApiKey(raw)).toBe(hash);
    expect(hash).not.toContain(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("InMemoryApiKeyStore", () => {
  test("a created key resolves back to its own record", async () => {
    const store = new InMemoryApiKeyStore();
    const { raw, record } = await store.create("polar");
    const resolved = await store.resolve(raw);
    expect(resolved).toEqual(record);
    expect(resolved!.owner).toBe("polar");
    expect(resolved!.revokedAt).toBeNull();
  });

  test("an unknown key resolves to null", async () => {
    const store = new InMemoryApiKeyStore();
    expect(await store.resolve("lw_nope")).toBeNull();
  });

  test("revoke makes the key stop resolving, and is idempotent-safe on an unknown id", async () => {
    const store = new InMemoryApiKeyStore();
    const { raw, record } = await store.create("polar");
    expect(await store.revoke(record.hash)).toBe(true);
    expect(await store.resolve(raw)).toBeNull();
    expect(await store.revoke("unknown-hash")).toBe(false);
  });

  test("rotate revokes the old key and issues a linked replacement", async () => {
    const store = new InMemoryApiKeyStore();
    const { raw: oldRaw, record: oldRecord } = await store.create("polar", {
      limit: 10,
      ttlMs: 1000,
    });
    const rotated = await store.rotate(oldRecord.hash);

    expect(rotated).not.toBeNull();
    expect(rotated!.raw).not.toBe(oldRaw);
    expect(rotated!.record.owner).toBe("polar");
    expect(rotated!.record.rotatedFrom).toBe(oldRecord.hash);
    expect(rotated!.record.rateLimit).toEqual({ limit: 10, ttlMs: 1000 });

    // Old key is dead, new one works.
    expect(await store.resolve(oldRaw)).toBeNull();
    expect(await store.resolve(rotated!.raw)).not.toBeNull();
  });

  test("rotating an unknown or already-revoked key returns null", async () => {
    const store = new InMemoryApiKeyStore();
    expect(await store.rotate("unknown-hash")).toBeNull();

    const { record } = await store.create("polar");
    await store.revoke(record.hash);
    expect(await store.rotate(record.hash)).toBeNull();
  });

  test("listByOwner returns only that owner's keys, including revoked ones", async () => {
    const store = new InMemoryApiKeyStore();
    const a = await store.create("polar");
    const b = await store.create("polar");
    await store.create("other-integrator");
    await store.revoke(a.record.hash);

    const keys = await store.listByOwner("polar");
    expect(keys.map((k) => k.hash).sort()).toEqual([a.record.hash, b.record.hash].sort());
  });
});
