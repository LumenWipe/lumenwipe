import { test, expect, beforeEach, describe } from "bun:test";
import { memoryKv } from "@/lib/kv";
import { runMessStep } from "@/lib/session-actions";
import {
  BATCH_SCHEMA_VERSION,
  createSessionStore,
  isSessionId,
  SESSION_COUNTDOWN_SECONDS,
  SESSION_LOCK_TTL_MS,
  SESSION_RECORD_TTL_SECONDS,
  SESSION_SCHEMA_VERSION,
  SessionLockLostError,
  sessionExpiresAt,
  sessionStore,
  type PlaygroundBatch,
  type PlaygroundSession,
  type SessionStore,
} from "@/lib/session-store";
import { EXCHANGE_STAND_IN } from "@/lib/scenarios";
import { fakeClock, memoryStore, newSessionData } from "./session-fixtures";

const SID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";

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
  expect(await memoryStore().loadSession("6f1c2a4e-3b5d-4c7e-9a8b-1d2e3f4a5b6c")).toBeNull();
});

test("updateSession merges the patch and keeps every other field", async () => {
  const store = memoryStore();
  const selection = { scenarios: [{ id: "data-entries" as const, params: { count: 3 } }] };
  const session = await store.createSession({ ...newSessionData(), selection });
  const lock = (await store.acquireLock(session.id))!;
  await store.updateSession(lock, (s) => ({ completedMessSteps: [...s.completedMessSteps, "A"] }));
  await store.updateSession(lock, (s) => ({ completedMessSteps: [...s.completedMessSteps, "B"] }));
  const loaded = await store.loadSession(session.id);
  expect(loaded?.completedMessSteps).toEqual(["A", "B"]);
  expect(loaded?.selection).toEqual(selection);
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

test("a stale lock holder cannot delete a session another request now holds", async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const session = await store.createSession(newSessionData());
  const stale = (await store.acquireLock(session.id))!;

  clock.advance(SESSION_LOCK_TTL_MS + 1_000);
  expect(await store.acquireLock(session.id)).not.toBeNull();

  await expect(store.deleteSession(stale)).rejects.toBeInstanceOf(SessionLockLostError);
  expect(await store.loadSession(session.id)).not.toBeNull();
});

test("a lock still inside its expiry is not freed", async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const session = await store.createSession(newSessionData());
  await store.acquireLock(session.id);
  clock.advance(SESSION_LOCK_TTL_MS - 1_000);
  expect(await store.acquireLock(session.id)).toBeNull();
});

test("deleteSession removes the session and its index entry", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const other = await store.createSession(newSessionData());
  expect((await store.indexedSessionIds()).sort()).toEqual([session.id, other.id].sort());
  const lock = (await store.acquireLock(session.id))!;
  await store.deleteSession(lock);
  expect(await store.loadSession(session.id)).toBeNull();
  expect(await store.indexedSessionIds()).toEqual([other.id]);
});

test("the record outlives the visitor's countdown, and the countdown is still one hour", async () => {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const session = await store.createSession(newSessionData());
  expect(SESSION_COUNTDOWN_SECONDS).toBe(3600);
  expect(sessionExpiresAt(clock.now()) - clock.now()).toBe(3600 * 1000);

  clock.advance(24 * 3600 * 1000);
  expect(await store.loadSession(session.id)).not.toBeNull();
  clock.advance(SESSION_RECORD_TTL_SECONDS * 1000 - 24 * 3600 * 1000 + 1);
  expect(await store.loadSession(session.id)).toBeNull();
  // The index keeps the id until the reaper prunes it.
  expect(await store.indexedSessionIds()).toEqual([session.id]);
  await store.unindexSession(session.id);
  expect(await store.indexedSessionIds()).toEqual([]);
});

test("the index survives in the dev file store, where an entry never expires", async () => {
  const a = await sessionStore.createSession(newSessionData());
  const b = await sessionStore.createSession(newSessionData());
  const ids = await sessionStore.indexedSessionIds();
  expect(ids).toContain(a.id);
  expect(ids).toContain(b.id);
  await sessionStore.unindexSession(a.id);
  expect(await sessionStore.indexedSessionIds()).not.toContain(a.id);
  await sessionStore.unindexSession(b.id);
});

test("a lease is exclusive until released, and the faucet failure reads back", async () => {
  const store = memoryStore();
  const lease = await store.acquireLease("reaper", 60_000);
  expect(lease).not.toBeNull();
  expect(await store.acquireLease("reaper", 60_000)).toBeNull();
  await store.releaseLease(lease!);
  expect(await store.acquireLease("reaper", 60_000)).not.toBeNull();

  expect(await store.lastFaucetFailure()).toBeNull();
  await store.recordFaucetFailure("rate_limited");
  expect(await store.lastFaucetFailure()).toBe("rate_limited");
  await store.recordFaucetFailure(null);
  expect(await store.lastFaucetFailure()).toBeNull();
});

describe("schema version", () => {
  const stored = async (value: unknown): Promise<SessionStore> => {
    const kv = memoryKv();
    await kv.set(`playground:session:${SID}`, value, 60);
    return createSessionStore(() => kv);
  };
  const current = (): PlaygroundSession => ({
    ...newSessionData(),
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: SID,
    createdAt: 1,
  });

  test("a new session is stamped with the current schema version and reads back", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    expect(session.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(await store.loadSession(session.id)).toEqual(session);
  });

  test("a session with the current version and a valid shape loads", async () => {
    expect(await (await stored(current())).loadSession(SID)).toEqual(current());
  });

  test("a session with no schema version reads as expired", async () => {
    const { schemaVersion: _omitted, ...legacy } = current();
    expect(await (await stored(legacy)).loadSession(SID)).toBeNull();
  });

  test("a session with an older schema version reads as expired", async () => {
    expect(await (await stored({ ...current(), schemaVersion: 0 })).loadSession(SID)).toBeNull();
  });

  test("a version 1 session, saved before signers were recorded, reads as expired", async () => {
    const { recordedSigners: _omitted, ...v1 } = { ...current(), schemaVersion: 1 };
    expect(await (await stored(v1)).loadSession(SID)).toBeNull();
  });

  test("a version 2 session, saved before an in-flight close was recorded, reads as expired", async () => {
    const { demolishPending: _omitted, ...v2 } = { ...current(), schemaVersion: 2 };
    expect(await (await stored(v2)).loadSession(SID)).toBeNull();
  });

  test("a version 3 session, saved with counts instead of a scenario selection, reads as expired", async () => {
    const { selection: _omitted, ...rest } = current();
    const v3 = { ...rest, schemaVersion: 3, fundRareAssets: [], offerCount: 0, dataEntryCount: 0 };
    expect(await (await stored(v3)).loadSession(SID)).toBeNull();
  });

  test("a version 4 session, saved before a transfer recipient was recorded, reads as expired", async () => {
    const { transferRecipient: _omitted, ...v4 } = { ...current(), schemaVersion: 4 };
    expect(await (await stored(v4)).loadSession(SID)).toBeNull();
    expect(await (await stored({ ...current(), schemaVersion: 4 })).loadSession(SID)).toBeNull();
  });

  test("a version 5 session, saved before helpers and claimable balances were recorded, reads as expired", async () => {
    const { helperAccounts: _h, claimableBalances: _c, ...v5 } = { ...current(), schemaVersion: 5 };
    expect(await (await stored(v5)).loadSession(SID)).toBeNull();
  });

  test("a version 6 session, saved with signers as bare public keys, reads as expired", async () => {
    const v6 = { ...current(), schemaVersion: 6, recordedSigners: ["GSIGNER"] };
    expect(await (await stored(v6)).loadSession(SID)).toBeNull();
    expect(await (await stored({ ...current(), schemaVersion: 6 })).loadSession(SID)).toBeNull();
  });

  test("a version 7 session, saved before allowances were recorded, reads as expired", async () => {
    const { allowances: _omitted, ...v7 } = { ...current(), schemaVersion: 7 };
    expect(await (await stored(v7)).loadSession(SID)).toBeNull();
    // Even with the field present: an older record is never read as the current shape.
    expect(await (await stored({ ...current(), schemaVersion: 7 })).loadSession(SID)).toBeNull();
  });

  test("a version 8 session, saved before an exchange close was recorded, reads as expired", async () => {
    const { exchange: _omitted, ...v8 } = { ...current(), schemaVersion: 8 };
    expect(await (await stored(v8)).loadSession(SID)).toBeNull();
    // Even with the field present: an older record is never read as the current shape.
    expect(await (await stored({ ...current(), schemaVersion: 8 })).loadSession(SID)).toBeNull();
  });

  test("a version 10 session, saved with the swap assets named USDC and EURC, reads as expired", async () => {
    const v10 = {
      ...current(),
      schemaVersion: 10,
      ephemeralIssuers: [{ assetCode: "USDC", publicKey: "GISSUER", encSecret: "enc" }],
      completedMessSteps: ["SETUP", "TRUST_USDC"],
    };
    expect(await (await stored(v10)).loadSession(SID)).toBeNull();
    expect(await (await stored({ ...current(), schemaVersion: 10 })).loadSession(SID)).toBeNull();
  });

  test("a session's exchange loads only as the bundled stand-in with an id memo", async () => {
    const exchange = {
      destination: EXCHANGE_STAND_IN.address,
      memo: "4411",
      memoType: "id" as const,
    };
    const withExchange = { ...current(), exchange };
    expect(await (await stored(withExchange)).loadSession(SID)).toEqual(withExchange);
    const largest = { ...exchange, memo: "18446744073709551615" };
    expect(await (await stored({ ...current(), exchange: largest })).loadSession(SID)).toEqual({
      ...current(),
      exchange: largest,
    });
    for (const bad of [
      { ...exchange, destination: "GSTANDIN" },
      { ...exchange, memoType: "text" },
      { ...exchange, memo: "18446744073709551616" },
      { ...exchange, memo: "0441" },
      { ...exchange, memo: "-1" },
      { ...exchange, memo: "12a" },
      { ...exchange, memo: 4411 },
      { ...exchange, memo: "" },
      EXCHANGE_STAND_IN.address,
    ]) {
      expect(await (await stored({ ...current(), exchange: bad })).loadSession(SID)).toBeNull();
    }
    const { exchange: _omitted, ...missing } = current();
    expect(await (await stored(missing)).loadSession(SID)).toBeNull();
  });

  test("an in-flight record keeps the balance its forward was held to, or none", async () => {
    const pending = {
      txId: "t",
      hash: "h",
      summary: "s",
      operations: [],
      validUntil: null,
      closesAccount: true,
    };
    for (const recordedBalance of [null, "29.9999800"]) {
      const value = { ...current(), demolishPending: { ...pending, recordedBalance } };
      expect(await (await stored(value)).loadSession(SID)).toEqual(value);
    }
    for (const recordedBalance of [undefined, "29.99998001", 29.99998, "x"]) {
      const value = { ...current(), demolishPending: { ...pending, recordedBalance } };
      expect(await (await stored(value)).loadSession(SID)).toBeNull();
    }
  });

  test("a session with recorded allowances loads with them; a malformed one does not", async () => {
    const allowance = { token: "CTOKEN", spender: "GSPENDER", liveUntilLedger: 8_760_306 };
    const withAllowances = { ...current(), allowances: [allowance] };
    expect(await (await stored(withAllowances)).loadSession(SID)).toEqual(withAllowances);
    for (const bad of [
      { ...allowance, spender: undefined },
      { ...allowance, token: 7 },
      { ...allowance, liveUntilLedger: "8760306" },
      { ...allowance, liveUntilLedger: 1.5 },
      { ...allowance, liveUntilLedger: 0 },
      "GSPENDER",
    ]) {
      expect(await (await stored({ ...current(), allowances: [bad] })).loadSession(SID)).toBeNull();
    }
    expect(await (await stored({ ...current(), allowances: null })).loadSession(SID)).toBeNull();
  });

  test("a session with typed signers loads with them; a signer of another type does not", async () => {
    const signer = <T extends string>(type: T, encSecret: string | null) => ({
      type,
      key: "K",
      weight: 1,
      encSecret,
    });
    const withSigners: PlaygroundSession = {
      ...current(),
      recordedSigners: [
        signer("ed25519_public_key", "e"),
        signer("hash_x", "e"),
        signer("preauth_tx", null),
      ],
    };
    expect(await (await stored(withSigners)).loadSession(SID)).toEqual(withSigners);
    const signedPayload = {
      ...current(),
      recordedSigners: [signer("ed25519_signed_payload", null)],
    };
    expect(await (await stored(signedPayload)).loadSession(SID)).toBeNull();
    const missingSecret = {
      ...current(),
      recordedSigners: [{ type: "hash_x", key: "K", weight: 1 }],
    };
    expect(await (await stored(missingSecret)).loadSession(SID)).toBeNull();
  });

  test("a session with helpers and recorded balances loads with them", async () => {
    const withRecords: PlaygroundSession = {
      ...current(),
      helperAccounts: [{ role: "claimant", publicKey: "G", encSecret: "e" }],
      claimableBalances: [{ id: "00", asset: "native", intent: "demo_sponsored" }],
    };
    expect(await (await stored(withRecords)).loadSession(SID)).toEqual(withRecords);
  });

  test("a session with a transfer recipient loads with it", async () => {
    const withRecipient = { ...current(), transferRecipient: { publicKey: "G", encSecret: "e" } };
    expect(await (await stored(withRecipient)).loadSession(SID)).toEqual(withRecipient);
  });

  test("a session whose stored selection is not valid reads as expired", async () => {
    for (const selection of [
      undefined,
      { scenarios: [] },
      { scenarios: [{ id: "stale-offers", params: { count: 1 } }] },
      { scenarios: [{ id: "data-entries", params: { count: 99 } }] },
      { scenarios: [{ id: "no-such-scenario", params: {} }] },
    ]) {
      expect(await (await stored({ ...current(), selection })).loadSession(SID)).toBeNull();
    }
  });

  test("a session with a demolish transaction in flight loads with it", async () => {
    const inFlight = {
      ...current(),
      demolishPending: {
        txId: "t",
        hash: "h",
        summary: "s",
        operations: [],
        validUntil: null,
        closesAccount: true,
        recordedBalance: null,
      },
    };
    expect(await (await stored(inFlight)).loadSession(SID)).toEqual(inFlight);
  });

  test("a malformed session reads as expired", async () => {
    for (const bad of [
      { ...current(), completedMessSteps: "SETUP" },
      { ...current(), recordedSigners: [1] },
      { ...current(), ephemeralIssuers: [{ publicKey: "G", assetCode: "X" }] },
      { ...current(), demolishLog: [{ txId: "t", hash: "h", summary: "s" }] },
      { ...current(), demolishDone: "no" },
      { ...current(), demolishPending: undefined },
      { ...current(), transferRecipient: undefined },
      { ...current(), helperAccounts: undefined },
      { ...current(), helperAccounts: [{ role: "issuer", publicKey: "G", encSecret: "e" }] },
      { ...current(), helperAccounts: [{ role: 1, publicKey: "G", encSecret: "e" }] },
      { ...current(), claimableBalances: undefined },
      { ...current(), claimableBalances: [{ id: "00", asset: "native", intent: "steal" }] },
      { ...current(), claimableBalances: [{ id: 1, asset: "native", intent: "claim" }] },
      { ...current(), transferRecipient: { publicKey: "G" } },
      { ...current(), transferRecipient: { publicKey: 1, encSecret: "e" } },
      { ...current(), demolishPending: { txId: "t", hash: "h", summary: "s", operations: [] } },
      {
        ...current(),
        demolishPending: {
          txId: "t",
          hash: "h",
          summary: "s",
          operations: [],
          validUntil: "soon",
          closesAccount: false,
          recordedBalance: null,
        },
      },
      "not-a-session",
      [current()],
    ]) {
      expect(await (await stored(bad)).loadSession(SID)).toBeNull();
    }
  });

  test("the route answers a stale session with the expired-session response", async () => {
    const store = await stored({ ...current(), schemaVersion: 0 });
    const result = await runMessStep(store, SID, "SETUP", { executeStep: async () => "hash" });
    expect(result).toEqual({ status: 404, body: { error: "session_not_found" } });
  });
});

test("isSessionId accepts only a lowercase uuid v4", () => {
  expect(isSessionId(SID)).toBe(true);
  for (const bad of [
    "",
    "s1",
    SID.toUpperCase(),
    `${SID}\n`,
    "0b9d6a52-7c41-1e8f-a3b2-5c6d7e8f9a01",
    "0b9d6a52-7c41-4e8f-c3b2-5c6d7e8f9a01",
    "%s%s%s",
  ]) {
    expect(isSessionId(bad)).toBe(false);
  }
});

describe("batch records", () => {
  const IDS = [
    "1a2b3c4d-1111-4222-8333-444455556666",
    "1a2b3c4d-2222-4333-8444-555566667777",
    "1a2b3c4d-3333-4444-8555-666677778888",
  ];

  test("a batch round-trips its member ids under a fresh id, apart from every session", async () => {
    const store = memoryStore();
    const batch = await store.createBatch(IDS);
    expect(isSessionId(batch.id)).toBe(true);
    expect(IDS).not.toContain(batch.id);
    expect(await store.loadBatch(batch.id)).toEqual(batch);
    expect(batch).toEqual({
      schemaVersion: BATCH_SCHEMA_VERSION,
      id: batch.id,
      memberIds: IDS,
      createdAt: batch.createdAt,
    });

    // A member's id names its session, never a batch, and a batch id names no session.
    const member = await store.createSession(newSessionData());
    expect(await store.loadBatch(member.id)).toBeNull();
    expect(await store.loadSession(batch.id)).toBeNull();
  });

  test("createBatch refuses one or four members, a repeated one, or a malformed id", async () => {
    const store = memoryStore();
    for (const ids of [IDS.slice(0, 1), [...IDS, SID], [IDS[0]!, IDS[0]!], [IDS[0]!, "../x"]]) {
      await expect(store.createBatch(ids)).rejects.toThrow();
    }
  });

  test("a stored batch of another shape or version reads as none", async () => {
    const kv = memoryKv();
    const store = createSessionStore(() => kv);
    const valid: PlaygroundBatch = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      id: SID,
      memberIds: IDS,
      createdAt: 1,
    };
    const variants: unknown[] = [
      { ...valid, schemaVersion: BATCH_SCHEMA_VERSION + 1 },
      { ...valid, memberIds: IDS.slice(0, 1) },
      { ...valid, memberIds: [...IDS, IDS[0]] },
      { ...valid, memberIds: [IDS[0], SID] },
      { ...valid, id: IDS[0] },
      { ...valid, encDemoSecret: undefined, memberIds: "all" },
    ];
    for (const value of variants) {
      await kv.set(`playground:batch:${SID}`, value, 60);
      expect(await store.loadBatch(SID)).toBeNull();
    }
    await kv.set(`playground:batch:${SID}`, valid, 60);
    expect(await store.loadBatch(SID)).toEqual(valid);
  });
});
