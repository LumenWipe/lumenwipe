import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import type { Firestore } from "@google-cloud/firestore";
import {
  FirestoreUsedChallengeStore,
  InMemoryUsedChallengeStore,
  createUsedChallengeStore,
} from "@/integrator/used-challenge-store";

describe("createUsedChallengeStore", () => {
  test("uses Firestore whenever a project is configured, and memory only without one", () => {
    const saved = process.env.FIRESTORE_PROJECT_ID;
    try {
      process.env.FIRESTORE_PROJECT_ID = "test-project";
      expect(createUsedChallengeStore()).toBeInstanceOf(FirestoreUsedChallengeStore);
      delete process.env.FIRESTORE_PROJECT_ID;
      expect(createUsedChallengeStore()).toBeInstanceOf(InMemoryUsedChallengeStore);
    } finally {
      if (saved === undefined) delete process.env.FIRESTORE_PROJECT_ID;
      else process.env.FIRESTORE_PROJECT_ID = saved;
    }
  });
});

describe("InMemoryUsedChallengeStore", () => {
  test("a challenge is claimed once until it expires", async () => {
    let now = 0;
    const store = new InMemoryUsedChallengeStore(() => now);
    expect(await store.claim("a", new Date(1_000))).toBe(true);
    expect(await store.claim("a", new Date(1_000))).toBe(false);
    expect(await store.claim("b", new Date(1_000))).toBe(true);
    now = 1_000;
    expect(await store.claim("a", new Date(2_000))).toBe(true);
  });
});

function fakeFirestore(create: (id: string, data: unknown) => Promise<unknown>) {
  const written: { id: string; data: unknown }[] = [];
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        create: (data: unknown) => {
          written.push({ id, data });
          return create(id, data);
        },
      }),
    }),
  } as unknown as Firestore;
  return { firestore, written };
}

describe("FirestoreUsedChallengeStore", () => {
  test("creates one document per challenge, named by its hash, with the TTL field", async () => {
    const seen = new Set<string>();
    const { firestore, written } = fakeFirestore(async (id) => {
      if (seen.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
      seen.add(id);
    });
    const store = new FirestoreUsedChallengeStore(firestore);
    const expiresAt = new Date("2026-01-01T00:05:00Z");
    expect(await store.claim("nonce", expiresAt)).toBe(true);
    expect(await store.claim("nonce", expiresAt)).toBe(false);
    expect(written[0]!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(written[0]!.id).not.toContain("nonce");
    expect((written[0]!.data as { expireAt: { toDate(): Date } }).expireAt.toDate()).toEqual(
      expiresAt
    );
  });

  test("a store that fails or hangs answers 503 and never claims", async () => {
    const failing = new FirestoreUsedChallengeStore(
      fakeFirestore(async () => {
        throw new Error("unavailable");
      }).firestore
    );
    const hanging = new FirestoreUsedChallengeStore(
      fakeFirestore(() => new Promise(() => undefined)).firestore,
      "usedChallenges",
      5
    );
    for (const store of [failing, hanging]) {
      const error = await store.claim("nonce", new Date()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(503);
    }
  });
});
