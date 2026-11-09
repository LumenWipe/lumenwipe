import { test, expect, beforeEach, describe } from "bun:test";
import { memoryKv } from "@/lib/kv";
import { runMessStep } from "@/lib/session-actions";
import {
  createSessionStore,
  SESSION_LOCK_TTL_MS,
  SESSION_SCHEMA_VERSION,
  SessionLockLostError,
  sessionStore,
  type PlaygroundSession,
  type SessionStore,
} from "@/lib/session-store";
import { fakeClock, memoryStore, newSessionData } from "./session-fixtures";

beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.NODE_ENV = "test";
});

test("create → load round-trips the session in the dev file fallback store", async () => {
  const session = await sessionStore.createSession(newSessionData());
  const loaded = await sessionStore.loadSession(session.id);
  expect(loaded?.demoPublic).toBe("GDEMO");
});

test("the dev file fallback store keeps the lock and the lock-held update working", async () => {
  const session = await sessionStore.createSession(newSessionData());
  const lock = await sessionStore.acquireLock(session.id);
  expect(lock).not.toBeNull();
  expect(await sessionStore.acquireLock(session.id)).toBeNull();
  await sessionStore.updateSession(lock!, () => ({ completedMessSteps: ["SETUP"] }));
  await sessionStore.releaseLock(lock!);
  expect((await sessionStore.loadSession(session.id))?.completedMessSteps).toEqual(["SETUP"]);
  expect(await sessionStore.acquireLock(session.id)).not.toBeNull();
});

test("loading an unknown id returns null", async () => {
  expect(await memoryStore().loadSession("nonexistent")).toBeNull();
});

test("updateSession merges the patch and keeps every other field", async () => {
  const store = memoryStore();
  const session = await store.createSession({ ...newSessionData(), offerCount: 3 });
  const lock = (await store.acquireLock(session.id))!;
  await store.updateSession(lock, (s) => ({ completedMessSteps: [...s.completedMessSteps, "A"] }));
  await store.updateSession(lock, (s) => ({ completedMessSteps: [...s.completedMessSteps, "B"] }));
  const loaded = await store.loadSession(session.id);
  expect(loaded?.completedMessSteps).toEqual(["A", "B"]);
  expect(loaded?.offerCount).toBe(3);
  expect(loaded?.id).toBe(session.id);
});

test("a second lock on the same session is refused while the first is held", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const first = await store.acquireLock(session.id);
  expect(first).not.toBeNull();
  expect(await store.acquireLock(session.id)).toBeNull();
  await store.releaseLock(first!);
  expect(await store.acquireLock(session.id)).not.toBeNull();
});

test("an expired lock frees the session and its stale holder can no longer write", async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const session = await store.createSession(newSessionData());
  const stale = (await store.acquireLock(session.id))!;

  clock.advance(SESSION_LOCK_TTL_MS + 1_000);
  const fresh = await store.acquireLock(session.id);
  expect(fresh).not.toBeNull();

  await expect(
    store.updateSession(stale, () => ({ completedMessSteps: ["STALE"] }))
  ).rejects.toBeInstanceOf(SessionLockLostError);
  expect((await store.loadSession(session.id))?.completedMessSteps).toEqual([]);

  await store.releaseLock(stale);
  expect(await store.acquireLock(session.id)).toBeNull();
});

test("a lock still inside its expiry is not freed", async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const session = await store.createSession(newSessionData());
  await store.acquireLock(session.id);
  clock.advance(SESSION_LOCK_TTL_MS - 1_000);
  expect(await store.acquireLock(session.id)).toBeNull();
});

test("deleteSession removes the session", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const lock = (await store.acquireLock(session.id))!;
  await store.deleteSession(lock);
  expect(await store.loadSession(session.id)).toBeNull();
});

describe("schema version", () => {
  const stored = async (value: unknown): Promise<SessionStore> => {
    const kv = memoryKv();
    await kv.set("playground:session:s1", value, 60);
    return createSessionStore(() => kv);
  };
  const current = (): PlaygroundSession => ({
    ...newSessionData(),
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: "s1",
    createdAt: 1,
  });

  test("a new session is stamped with the current schema version and reads back", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    expect(session.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(await store.loadSession(session.id)).toEqual(session);
  });

  test("a session with the current version and a valid shape loads", async () => {
    expect(await (await stored(current())).loadSession("s1")).toEqual(current());
  });

  test("a session with no schema version reads as expired", async () => {
    const { schemaVersion: _omitted, ...legacy } = current();
    expect(await (await stored(legacy)).loadSession("s1")).toBeNull();
  });

  test("a session with an older schema version reads as expired", async () => {
    expect(await (await stored({ ...current(), schemaVersion: 0 })).loadSession("s1")).toBeNull();
  });

  test("a malformed session reads as expired", async () => {
    for (const bad of [
      { ...current(), completedMessSteps: "SETUP" },
      { ...current(), ephemeralIssuers: [{ publicKey: "G", assetCode: "X" }] },
      { ...current(), demolishLog: [{ txId: "t", hash: "h", summary: "s" }] },
      { ...current(), demolishDone: "no" },
      "not-a-session",
      [current()],
    ]) {
      expect(await (await stored(bad)).loadSession("s1")).toBeNull();
    }
  });

  test("the route answers a stale session with the expired-session response", async () => {
    const store = await stored({ ...current(), schemaVersion: 0 });
    const result = await runMessStep(store, "s1", "SETUP", { executeStep: async () => "hash" });
    expect(result).toEqual({ status: 404, body: { error: "session_not_found" } });
  });
});
