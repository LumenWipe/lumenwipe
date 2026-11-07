import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDB } from "idb";
import {
  getHistory,
  listHistory,
  normaliseHistory,
  saveHistory,
  updateHistory,
} from "@/lib/session/history";
import type { LegacyHistoryEntry, ReceiptRecord } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

beforeEach(() => installIndexedDb());
afterEach(() => removeIndexedDb());

const LEGACY: LegacyHistoryEntry = {
  id: "old",
  network: "testnet",
  sourceAddress: "GSOURCE",
  destinationAddress: "GDEST",
  completedAt: "2026-01-02T03:04:05.000Z",
  txReceipts: [{ type: "CLOSE_ACCOUNT", title: "Close account", txHash: "abc" }],
  totalFeeLumens: "0.0000100",
  usedMediator: true,
};

function record(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "new",
    network: "testnet",
    sourceAddress: "GSOURCE",
    destinationAddress: "GDEST",
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-01T00:00:00.000Z",
    memo: { text: "123", type: "id" },
    transactions: [{ txHash: "h", label: "Close", stepTypes: ["MERGE"], stepTitles: ["Merge"] }],
    groups: [],
    feeLumens: "0.0000100",
    receivedLumens: null,
    ...over,
  };
}

/** A version 2 database as the code before the receipt record wrote it, with one old entry. */
async function seedVersion2Database(): Promise<void> {
  const db = await openDB("lumenwipe", 2, {
    upgrade(db) {
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("history", { keyPath: "id" });
    },
  });
  await db.put("history", LEGACY);
  db.close();
}

test("an entry written before the version field still reads from a version 2 database", async () => {
  await seedVersion2Database();

  const [listed] = await listHistory();
  const read = await getHistory("old");
  for (const entry of [listed, read]) {
    expect(entry).toEqual({
      version: RECORD_VERSION,
      id: "old",
      network: "testnet",
      sourceAddress: "GSOURCE",
      destinationAddress: "GDEST",
      mediatorRequired: true,
      outcome: "closed",
      completedAt: "2026-01-02T03:04:05.000Z",
      memo: null,
      transactions: [
        {
          txHash: "abc",
          label: "Close account",
          stepTypes: ["CLOSE_ACCOUNT"],
          stepTitles: ["Close account"],
        },
      ],
      groups: null,
      feeLumens: "0.0000100",
      receivedLumens: null,
    });
  }
});

test("a saved record reads back as written, next to an old one, newest first", async () => {
  await seedVersion2Database();
  await saveHistory(record());

  expect(await getHistory("new")).toEqual(record());
  expect((await listHistory()).map((e) => e.id)).toEqual(["new", "old"]);
});

test("an unknown id reads as null", async () => {
  expect(await getHistory("missing")).toBeNull();
});

test("a current record missing a later field reads it as not recorded", () => {
  const { receivedLumens: _dropped, ...partial } = record({ receivedLumens: "5" });
  expect(normaliseHistory(partial as ReceiptRecord).receivedLumens).toBeNull();
});

test("updateHistory fills in the received amount and keeps the rest", async () => {
  await saveHistory(record());
  expect(await updateHistory("new", { receivedLumens: "99.5000000" })).toBe(true);
  expect(await getHistory("new")).toEqual(record({ receivedLumens: "99.5000000" }));
});

test("updateHistory migrates an old entry it fills in", async () => {
  await seedVersion2Database();
  expect(await updateHistory("old", { receivedLumens: "1" })).toBe(true);
  const read = await getHistory("old");
  expect(read?.receivedLumens).toBe("1");
  expect(read?.transactions[0].txHash).toBe("abc");
});

test("updateHistory never recreates a receipt that is gone", async () => {
  expect(await updateHistory("missing", { receivedLumens: "1" })).toBe(false);
  expect(await listHistory()).toEqual([]);
});
