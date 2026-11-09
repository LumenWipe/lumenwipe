import { test, expect, beforeEach } from "bun:test";
import { SESSION_LOCK_TTL_MS, SessionLockLostError, sessionStore } from "@/lib/session-store";
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
