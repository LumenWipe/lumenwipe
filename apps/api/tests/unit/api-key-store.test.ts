import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import type { Firestore } from "@google-cloud/firestore";
import {
  FirestoreApiKeyStore,
  generateApiKey,
  hashApiKey,
  InMemoryApiKeyStore,
} from "@/auth/api-key-store";
import { runApiKeyStoreContract } from "../support/api-key-store-contract";

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

runApiKeyStoreContract("InMemoryApiKeyStore", () => new InMemoryApiKeyStore());

interface FakeDoc {
  id: string;
}

function fakeFirestore(runTransaction: Firestore["runTransaction"]): Firestore {
  const doc = (id: string): FakeDoc => ({ id });
  return {
    collection: () => ({ doc, where: () => ({ get: () => new Promise(() => {}) }) }),
    runTransaction,
  } as unknown as Firestore;
}

async function unavailable(p: Promise<unknown>): Promise<void> {
  const error = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  expect(http.getStatus()).toBe(503);
  const body = http.getResponse() as { error: { code: string; message: string } };
  expect(body.error.code).toBe("service_unavailable");
  expect(body.error.message).not.toMatch(/lw_|firestore|timed out/i);
}

describe("FirestoreApiKeyStore deadline", () => {
  const hang = (): Promise<never> => new Promise(() => {});

  test("every operation fails with a plain 503 instead of hanging", async () => {
    const firestore = {
      collection: () => ({
        doc: () => ({ get: hang, create: hang }),
        where: () => ({ get: hang }),
      }),
      runTransaction: hang,
    } as unknown as Firestore;
    const store = new FirestoreApiKeyStore(firestore, "apiKeys", 20);

    await unavailable(store.create("polar"));
    await unavailable(store.resolve("lw_synthetic"));
    await unavailable(store.findByHash("hash"));
    await unavailable(store.listByOwner("polar"));
    await unavailable(store.revoke("hash"));
    await unavailable(store.rotate("hash"));
  });

  test("a store failure that is not a timeout is not disguised as one", async () => {
    const firestore = fakeFirestore((async () => {
      throw new Error("permission denied");
    }) as Firestore["runTransaction"]);
    const store = new FirestoreApiKeyStore(firestore, "apiKeys", 20);
    expect(store.revoke("hash")).rejects.toThrow("permission denied");
  });
});

describe("FirestoreApiKeyStore rotate retries", () => {
  test("a transaction retry reuses the same replacement key", async () => {
    const created: string[] = [];
    const tx = {
      get: async () => ({
        exists: true,
        id: "old-hash",
        data: () => ({
          owner: "polar",
          createdAt: { toDate: () => new Date() },
          revokedAt: null,
          rotatedFrom: null,
          rateLimit: null,
        }),
      }),
      create: (ref: FakeDoc) => created.push(ref.id),
      update: () => undefined,
    };
    const firestore = fakeFirestore((async (fn: (t: typeof tx) => Promise<unknown>) => {
      await fn(tx);
      return fn(tx);
    }) as unknown as Firestore["runTransaction"]);
    const store = new FirestoreApiKeyStore(firestore);

    const rotated = await store.rotate("old-hash");

    expect(created).toHaveLength(2);
    expect(created[0]).toBe(created[1]);
    expect(hashApiKey(rotated!.raw)).toBe(created[0]);
  });
});
