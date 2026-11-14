import { describe, expect, test } from "bun:test";
import { handleExtendBatch } from "@/lib/batch-handlers";
import { handleExtend } from "@/lib/route-handlers";
import { REAP_AFTER_MS } from "@/lib/reaper";
import {
  runCleanup,
  runDemolishRound,
  runExtend,
  runMessStep,
  runRevokeAllowance,
} from "@/lib/session-actions";
import {
  EXTENSION_WINDOW_SECONDS,
  SESSION_COUNTDOWN_SECONDS,
  SESSION_EXTENSION_SECONDS,
  isPlaygroundSession,
  type SessionStore,
} from "@/lib/session-store";
import { memoryStore, newSessionData } from "./session-fixtures";

// The session's countdown: stored with the record, held by the mess and credentials routes only,
// and extended once, for a single session or for every member of a batch together.

const T0 = 1_900_000_000_000;
const MINUTE = 60_000;
const EXTENSION_MS = SESSION_EXTENSION_SECONDS * 1000;

const outcome = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.error === "string" ? r.body.error : "ok";

async function sessionExpiringAt(store: SessionStore, expiresAt: number, extra = {}) {
  return store.createSession({ ...newSessionData(), expiresAt, ...extra });
}

describe("the mess route", () => {
  test("a step after the countdown ends answers session_expired and executes nothing", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    let executed = 0;
    const result = await runMessStep(store, session.id, "SETUP", {
      executeStep: async () => {
        executed++;
        return "hash";
      },
      now: () => T0 + 1,
    });
    expect(result).toEqual({ status: 410, body: { error: "session_expired" } });
    expect(executed).toBe(0);
    expect((await store.loadSession(session.id))?.completedMessSteps).toEqual([]);
  });

  test("the countdown ends at exactly expiresAt, and a step a millisecond before it runs", async () => {
    const store = memoryStore();
    const atEnd = await sessionExpiringAt(store, T0);
    const before = await sessionExpiringAt(store, T0);
    const executeStep = async (): Promise<string> => "hash";
    const late = await runMessStep(store, atEnd.id, "SETUP", { executeStep, now: () => T0 });
    const early = await runMessStep(store, before.id, "SETUP", { executeStep, now: () => T0 - 1 });
    expect(outcome(late)).toBe("session_expired");
    expect(outcome(early)).toBe("ok");
  });
});

describe("the close is never refused for time", () => {
  test("a demolish round, a revoke and the cleanup all run after the countdown ends", async () => {
    const store = memoryStore();
    const spender = "GSPENDER";
    // Ended by the real clock too: the close routes take no clock to be held to.
    const session = await sessionExpiringAt(store, Date.now() - 10 * MINUTE, {
      allowances: [{ token: "CTOKEN", spender, liveUntilLedger: 100 }],
    });

    const revoke = await runRevokeAllowance(store, session.id, spender, {
      revoke: async () => "revoke-hash",
    });
    expect(outcome(revoke)).toBe("ok");

    let rounds = 0;
    const round = await runDemolishRound(store, session.id, {
      round: async () => {
        rounds++;
        return { done: true, remainingSteps: 0 };
      },
    });
    expect(outcome(round)).toBe("ok");
    expect(rounds).toBe(1);

    const cleanup = await runCleanup(store, session.id, {
      recycle: async () => ({ recycled: [], complete: true, patch: {} }),
    });
    expect(outcome(cleanup)).toBe("ok");
  });
});

describe("the one extension", () => {
  const inWindow = T0 - 2 * MINUTE;

  test("adds exactly the extension to the stored expiry, not to the current time", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    const result = await runExtend(store, [session.id], () => inWindow);
    expect(result).toEqual({ status: 200, body: { expiresAt: T0 + EXTENSION_MS, extended: true } });
    const stored = await store.loadSession(session.id);
    expect(stored?.expiresAt).toBe(T0 + EXTENSION_MS);
    expect(stored?.extended).toBe(true);
  });

  test("a second extension is extension_used and leaves the expiry as it was", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    await runExtend(store, [session.id], () => inWindow);
    const nearNewEnd = T0 + EXTENSION_MS - MINUTE;
    const again = await runExtend(store, [session.id], () => nearNewEnd);
    expect(again).toEqual({ status: 409, body: { error: "extension_used" } });
    expect((await store.loadSession(session.id))?.expiresAt).toBe(T0 + EXTENSION_MS);
  });

  test("an expired session cannot be extended", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    expect(outcome(await runExtend(store, [session.id], () => T0))).toBe("session_expired");
    expect((await store.loadSession(session.id))?.extended).toBe(false);
  });

  test("is refused before the last five minutes, and accepted at five minutes left", async () => {
    const store = memoryStore();
    const early = await sessionExpiringAt(store, T0);
    const edge = await sessionExpiringAt(store, T0);
    const window = EXTENSION_WINDOW_SECONDS * 1000;
    expect(outcome(await runExtend(store, [early.id], () => T0 - window - 1))).toBe(
      "extension_not_yet"
    );
    expect((await store.loadSession(early.id))?.extended).toBe(false);
    expect(outcome(await runExtend(store, [edge.id], () => T0 - window))).toBe("ok");
  });

  test("a closed session has nothing to extend", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0, { demolishDone: true });
    expect(outcome(await runExtend(store, [session.id], () => inWindow))).toBe("demolish_started");
  });

  test("the route answers with the new expiry", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    const res = await handleExtend(session.id, { store, now: () => inWindow });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresAt: T0 + EXTENSION_MS, extended: true });
    const unknown = await handleExtend("6f1c2a4e-3b5d-4c7e-9a8b-1d2e3f4a5b6c", { store });
    expect(unknown.status).toBe(404);
  });

  test("the longest countdown ends at least half an hour before the reaper may reap", () => {
    const longest = (SESSION_COUNTDOWN_SECONDS + SESSION_EXTENSION_SECONDS) * 1000;
    expect(REAP_AFTER_MS - longest).toBeGreaterThanOrEqual(30 * MINUTE);
  });
});

describe("a batch's extension", () => {
  async function batchOf(store: SessionStore, size: number) {
    const members = [];
    for (let i = 0; i < size; i++) members.push(await sessionExpiringAt(store, T0));
    const batch = await store.createBatch(members.map((m) => m.id));
    return { batch, ids: members.map((m) => m.id) };
  }

  test("moves every member to the same expiry at once", async () => {
    const store = memoryStore();
    const { batch, ids } = await batchOf(store, 3);
    const res = await handleExtendBatch(batch.id, { store, now: () => T0 - MINUTE });
    expect(res.status).toBe(200);
    for (const id of ids) {
      const stored = await store.loadSession(id);
      expect(stored?.expiresAt).toBe(T0 + EXTENSION_MS);
      expect(stored?.extended).toBe(true);
    }
  });

  test("a retry after a busy member finishes the rest without extending anyone twice", async () => {
    const store = memoryStore();
    const { ids } = await batchOf(store, 3);
    const held = await store.acquireLock(ids[1]!);
    const busy = await runExtend(store, ids, () => T0 - MINUTE);
    expect(busy).toEqual({ status: 409, body: { error: "step_in_progress" } });
    expect((await store.loadSession(ids[0]!))?.extended).toBe(true);
    expect((await store.loadSession(ids[2]!))?.extended).toBe(false);
    await store.releaseLock(held!);

    const retried = await runExtend(store, ids, () => T0 - MINUTE);
    expect(retried).toEqual({
      status: 200,
      body: { expiresAt: T0 + EXTENSION_MS, extended: true },
    });
    for (const id of ids) {
      expect((await store.loadSession(id))?.expiresAt).toBe(T0 + EXTENSION_MS);
    }
    expect(outcome(await runExtend(store, ids, () => T0 + MINUTE))).toBe("extension_used");
  });

  test("members whose expiry differs are refused, and nothing moves", async () => {
    const store = memoryStore();
    const a = await sessionExpiringAt(store, T0);
    const b = await sessionExpiringAt(store, T0 + 1);
    expect(outcome(await runExtend(store, [a.id, b.id], () => T0 - MINUTE))).toBe("extension_used");
    expect((await store.loadSession(a.id))?.extended).toBe(false);
  });

  test("an unknown batch is batch_not_found", async () => {
    const res = await handleExtendBatch("6f1c2a4e-3b5d-4c7e-9a8b-1d2e3f4a5b6c", {
      store: memoryStore(),
    });
    expect(res.status).toBe(404);
  });
});

describe("the stored record", () => {
  test("a record without its expiry, or with a non-boolean extension, reads as expired", async () => {
    const store = memoryStore();
    const session = await sessionExpiringAt(store, T0);
    const { expiresAt: _dropped, ...withoutExpiry } = session;
    expect(isPlaygroundSession(session)).toBe(true);
    expect(isPlaygroundSession(withoutExpiry)).toBe(false);
    expect(isPlaygroundSession({ ...session, extended: "no" })).toBe(false);
    expect(isPlaygroundSession({ ...session, expiresAt: Number.NaN })).toBe(false);
  });
});
