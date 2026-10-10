import { describe, expect, test } from "bun:test";
import { hashApiKey, type ApiKeyStore } from "@/auth/api-key-store";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function runApiKeyStoreContract(label: string, makeStore: () => ApiKeyStore): void {
  describe(`ApiKeyStore contract: ${label}`, () => {
    test("a created key resolves back to its own record", async () => {
      const store = makeStore();
      const { raw, record } = await store.create("polar");
      expect(record.hash).toBe(hashApiKey(raw));
      expect(await store.resolve(raw)).toEqual(record);
      expect(record.revokedAt).toBeNull();
      expect(record.rotatedFrom).toBeNull();
    });

    test("an unknown key resolves to null", async () => {
      expect(await makeStore().resolve("lw_unknown")).toBeNull();
    });

    test("findByHash returns active and revoked records and null for unknown", async () => {
      const store = makeStore();
      const { record } = await store.create("polar");
      expect((await store.findByHash(record.hash))?.owner).toBe("polar");
      await store.revoke(record.hash);
      expect((await store.findByHash(record.hash))?.revokedAt).not.toBeNull();
      expect(await store.findByHash("unknown-hash")).toBeNull();
    });

    test("revoke stops the key resolving and reports an unknown id as false", async () => {
      const store = makeStore();
      const { raw, record } = await store.create("polar");
      expect(await store.revoke(record.hash)).toBe(true);
      expect(await store.resolve(raw)).toBeNull();
      expect(await store.revoke("unknown-hash")).toBe(false);
    });

    test("revoking an already revoked key keeps the original revokedAt", async () => {
      const store = makeStore();
      const { record } = await store.create("polar");
      await store.revoke(record.hash);
      const first = (await store.findByHash(record.hash))!.revokedAt!;
      await wait(15);
      expect(await store.revoke(record.hash)).toBe(true);
      expect((await store.findByHash(record.hash))!.revokedAt!.getTime()).toBe(first.getTime());
    });

    test("rotate retires the old key and issues a linked replacement", async () => {
      const store = makeStore();
      const limit = { limit: 10, ttlMs: 1000 };
      const { raw: oldRaw, record: old } = await store.create("polar", limit);
      const rotated = await store.rotate(old.hash);

      expect(rotated!.raw).not.toBe(oldRaw);
      expect(rotated!.record.owner).toBe("polar");
      expect(rotated!.record.rotatedFrom).toBe(old.hash);
      expect(rotated!.record.rateLimit).toEqual(limit);
      expect(await store.resolve(oldRaw)).toBeNull();
      expect(await store.resolve(rotated!.raw)).toEqual(rotated!.record);
    });

    test("rotating an unknown or revoked key returns null", async () => {
      const store = makeStore();
      expect(await store.rotate("unknown-hash")).toBeNull();
      const { record } = await store.create("polar");
      await store.revoke(record.hash);
      expect(await store.rotate(record.hash)).toBeNull();
    });

    test("two concurrent rotations yield exactly one replacement and one null", async () => {
      const store = makeStore();
      const { record } = await store.create("polar");
      const results = await Promise.all([store.rotate(record.hash), store.rotate(record.hash)]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const keys = await store.listByOwner("polar");
      expect(keys.filter((k) => !k.revokedAt)).toHaveLength(1);
      expect(keys).toHaveLength(2);
    });

    test("listByOwner returns only that owner's keys including revoked ones", async () => {
      const store = makeStore();
      const a = await store.create("polar");
      const b = await store.create("polar");
      await store.create("other");
      await store.revoke(a.record.hash);

      const keys = await store.listByOwner("polar");
      expect(keys.map((k) => k.hash).sort()).toEqual([a.record.hash, b.record.hash].sort());
    });

    test("records are copies and never carry the raw key", async () => {
      const store = makeStore();
      const { raw, record } = await store.create("polar", { limit: 5, ttlMs: 100 });
      record.owner = "tampered";
      record.revokedAt = new Date();
      record.rateLimit!.limit = 999;

      const fresh = (await store.findByHash(record.hash))!;
      expect(fresh.owner).toBe("polar");
      expect(fresh.revokedAt).toBeNull();
      expect(fresh.rateLimit).toEqual({ limit: 5, ttlMs: 100 });
      fresh.createdAt.setFullYear(1999);
      expect((await store.findByHash(record.hash))!.createdAt.getFullYear()).not.toBe(1999);
      expect(JSON.stringify(await store.listByOwner("polar"))).not.toContain(raw);
    });
  });
}
