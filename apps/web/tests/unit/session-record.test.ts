import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { cleanupSession, findResumableSession } from "@/lib/session/recovery";
import {
  confirmationOf,
  loadSession,
  recordConfirmed,
  saveSession,
  saveUnconfirmed,
  SESSION_MAX_AGE_MS,
} from "@/lib/session/store";
import { RECORD_VERSION, type SessionRecord } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  installIndexedDb();
  setSystemTime(NOW);
});

afterEach(() => {
  removeIndexedDb();
  setSystemTime();
});

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: RECORD_VERSION,
    id: "s",
    network: "testnet",
    sourceAddress: "GSOURCE",
    destinationAddress: "GDEST",
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    stepCount: 3,
    stepBase: 0,
    status: "in_progress",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** Writes rows the way an older build did: a version 2 database, records without the new fields. */
async function seedLegacyDatabase(rows: object[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("lumenwipe", 2);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("sessions", { keyPath: "id" });
      open.result.createObjectStore("history", { keyPath: "id" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    for (const row of rows) tx.objectStore("sessions").put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test("each confirmation appends one entry with its hash, once per hash", async () => {
  await saveSession(record());
  await recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES"], "a".repeat(64), 1));
  expect((await loadSession("s"))?.completedSteps).toHaveLength(1);

  await recordConfirmed("s", confirmationOf(["CANCEL_OFFERS"], "b".repeat(64), 2));
  await recordConfirmed("s", confirmationOf(["CANCEL_OFFERS"], "b".repeat(64), 2));

  const saved = await loadSession("s");
  expect(saved?.completedSteps).toEqual([
    { index: 0, type: "REMOVE_TRUSTLINES", txHash: "a".repeat(64), confirmedAt: NOW.toISOString() },
    { index: 1, type: "CANCEL_OFFERS", txHash: "b".repeat(64), confirmedAt: NOW.toISOString() },
  ]);
  expect(saved?.currentStepIndex).toBe(2);
  expect(saved?.status).toBe("in_progress");
});

test("the transaction carrying the merge completes the record", async () => {
  await saveSession(record());
  await recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES", "MERGE"], "c".repeat(64), 3));
  const saved = await loadSession("s");
  expect(saved?.status).toBe("completed");
  expect(saved?.completedSteps[0]?.type).toBe("MERGE");
});

test("a later review confirm never resets the recorded progress", async () => {
  await saveSession(record());
  await recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES"], "a".repeat(64), 1));
  await saveSession(record({ destinationAddress: "GOTHER" }));
  const saved = await loadSession("s");
  expect(saved?.destinationAddress).toBe("GOTHER");
  expect(saved?.completedSteps.map((s) => s.txHash)).toEqual(["a".repeat(64)]);
  expect(saved?.currentStepIndex).toBe(1);
});

test("a record that is gone is not recreated by a confirmation", async () => {
  expect(await recordConfirmed("s", confirmationOf(["MERGE"], "a".repeat(64), 1))).toBe(false);
  expect(await loadSession("s")).toBeNull();
});

test("clearing the hash right after a confirmation keeps the confirmation", async () => {
  await saveSession(record({ unconfirmed: { hash: "a".repeat(64), covers: [], validUntil: 5 } }));
  await Promise.all([
    saveUnconfirmed("s", null),
    recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES"], "a".repeat(64), 1)),
  ]);
  const saved = await loadSession("s");
  expect(saved?.unconfirmed).toBeUndefined();
  expect(saved?.completedSteps.map((s) => s.txHash)).toEqual(["a".repeat(64)]);
});

test("the written record holds no envelope, signature or key", async () => {
  const secret = "SDONOTSTOREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  await saveSession(record());
  await saveUnconfirmed("s", {
    hash: "a".repeat(64),
    covers: ["MERGE"],
    validUntil: 5,
    signedXdr: "AAAAenvelope",
    signatures: ["sig"],
    secret,
  } as never);
  await recordConfirmed("s", confirmationOf(["MERGE"], "a".repeat(64), 1));

  const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const open = indexedDB.open("lumenwipe");
    open.onsuccess = () => {
      const get = open.result.transaction("sessions").objectStore("sessions").get("s");
      get.onsuccess = () => {
        open.result.close();
        resolve(get.result as Record<string, unknown>);
      };
      get.onerror = () => reject(get.error);
    };
  });
  expect(Object.keys(raw).sort()).toEqual(
    [
      "completedSteps",
      "createdAt",
      "currentStepIndex",
      "destinationAddress",
      "id",
      "mediatorRequired",
      "memo",
      "memoType",
      "network",
      "sourceAddress",
      "status",
      "stepBase",
      "stepCount",
      "unconfirmed",
      "updatedAt",
      "version",
    ].sort()
  );
  const text = JSON.stringify(raw);
  for (const leaked of ["AAAAenvelope", 'sig"', secret]) expect(text).not.toContain(leaked);
});

test("a version 2 database written by an older build opens and reads with defaults", async () => {
  await seedLegacyDatabase([
    {
      id: "legacy",
      network: "testnet",
      sourceAddress: "GSOURCE",
      destinationAddress: "GDEST",
      memo: "42",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  ]);
  expect(await loadSession("legacy")).toEqual({
    version: RECORD_VERSION,
    id: "legacy",
    network: "testnet",
    sourceAddress: "GSOURCE",
    destinationAddress: "GDEST",
    memo: "42",
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    stepCount: null,
    stepBase: 0,
    status: "in_progress",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  expect((await findResumableSession("testnet"))?.id).toBe("legacy");
});

test("a version 1 record reads with no step count, so its progress is shown as transactions", async () => {
  const {
    stepCount: _count,
    stepBase: _base,
    ...v1
  } = record({
    version: 1,
    currentStepIndex: 2,
    completedSteps: [
      { index: 0, type: "CANCEL_OFFERS", txHash: "a".repeat(64), confirmedAt: NOW.toISOString() },
    ],
  });
  await seedLegacyDatabase([v1]);
  const saved = await loadSession("s");
  expect(saved?.version).toBe(RECORD_VERSION);
  expect(saved?.stepCount).toBeNull();
  expect(saved?.stepBase).toBe(0);
  expect(saved?.currentStepIndex).toBe(2);
});

test("a confirmation counts its plan's steps after those confirmed before that plan", async () => {
  await saveSession(record());
  await recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES"], "a".repeat(64), 1));
  expect((await loadSession("s"))?.currentStepIndex).toBe(1);

  await saveSession(record({ stepCount: 3 }));
  await recordConfirmed("s", confirmationOf(["CANCEL_OFFERS"], "b".repeat(64), 2));
  expect((await loadSession("s"))?.currentStepIndex).toBe(3);
});

test("the step count stays the whole close across a resume and a second review confirm", async () => {
  // First review: a plan of four steps, two of them confirmed before the page was lost.
  await saveSession(record({ stepCount: 4 }));
  await recordConfirmed("s", confirmationOf(["CANCEL_OFFERS"], "a".repeat(64), 1));
  await recordConfirmed("s", confirmationOf(["REMOVE_TRUSTLINES"], "b".repeat(64), 2));
  let saved = await loadSession("s");
  expect([saved?.currentStepIndex, saved?.stepCount]).toEqual([2, 4]);

  // Resumed: the fresh plan lists only the two steps left, and is confirmed on review again.
  await saveSession(record({ stepCount: 2 }));
  saved = await loadSession("s");
  expect([saved?.stepBase, saved?.currentStepIndex, saved?.stepCount]).toEqual([2, 2, 4]);

  await recordConfirmed("s", confirmationOf(["REMOVE_DATA_ENTRIES"], "c".repeat(64), 1));
  saved = await loadSession("s");
  expect([saved?.currentStepIndex, saved?.stepCount]).toEqual([3, 4]);
  await recordConfirmed("s", confirmationOf(["MERGE"], "d".repeat(64), 2));
  saved = await loadSession("s");
  expect([saved?.currentStepIndex, saved?.stepCount, saved?.status]).toEqual([4, 4, "completed"]);
});

test("a record untouched for more than seven days is not offered and is deleted", async () => {
  const age = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  await seedRaw([
    record({ id: "fresh", updatedAt: age(1 * DAY) }),
    record({ id: "recent", updatedAt: age(6 * DAY) }),
    record({ id: "stale", updatedAt: age(SESSION_MAX_AGE_MS + 1) }),
    record({
      id: "held",
      updatedAt: age(30 * DAY),
      unconfirmed: { hash: "a".repeat(64), covers: [], validUntil: 5 },
    }),
  ]);

  expect((await findResumableSession("testnet"))?.id).toBe("held");
  expect(await loadSession("stale")).toBeNull();
  expect(await loadSession("held")).not.toBeNull();
  expect(await loadSession("fresh")).not.toBeNull();
  expect(await loadSession("recent")).not.toBeNull();
});

test("only expired records left leaves nothing to resume", async () => {
  await seedRaw([
    record({ id: "stale", updatedAt: new Date(NOW.getTime() - 8 * DAY).toISOString() }),
  ]);
  expect(await findResumableSession("testnet")).toBeNull();
  expect(await loadSession("stale")).toBeNull();
});

/** Puts records exactly as given, timestamps included, through the app's own database. */
async function seedRaw(rows: SessionRecord[]): Promise<void> {
  await loadSession("open");
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("lumenwipe");
    open.onsuccess = () => {
      const tx = open.result.transaction("sessions", "readwrite");
      for (const row of rows) tx.objectStore("sessions").put(row);
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

test("cleaning up a finished close keeps a session that holds an unconfirmed hash", async () => {
  await saveSession(record({ id: "held" }));
  await saveUnconfirmed("held", { hash: "h", covers: ["MERGE"], validUntil: 0 } as never);
  await saveSession(record({ id: "settled" }));

  await cleanupSession("held");
  await cleanupSession("settled");

  expect((await loadSession("held"))?.unconfirmed?.hash).toBe("h");
  expect(await loadSession("settled")).toBeNull();
});
