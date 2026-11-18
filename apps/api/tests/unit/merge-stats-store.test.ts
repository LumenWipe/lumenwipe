import { describe, expect, test } from "bun:test";
import type { Firestore, Timestamp } from "@google-cloud/firestore";
import type { MergeRecord } from "@lumenwipe/types";
import { FirestoreMergeStatsStore } from "@/stats/merge-stats-store";

const CLOSE: MergeRecord = {
  txHash: "a".repeat(64),
  network: "mainnet",
  accountsClosed: 2,
  xlmStroops: "30000000",
  timestamp: "2026-10-08T10:15:00.000Z",
};

const snapshot = (fields: Record<string, unknown>, exists = true) => ({
  exists,
  get: (f: string) => fields[f],
});

function unreadable(): never {
  throw new Error("merges read");
}

/** Every read of `merges` throws, so a passing read cannot depend on a counted close existing. */
function firestoreWithoutMerges(totals: Record<string, unknown>, days: Record<string, unknown>[]) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => snapshot(totals),
        collection: (name: string) => {
          if (name === "merges") {
            return { doc: unreadable, get: unreadable, orderBy: unreadable, where: unreadable };
          }
          return {
            where: () => ({ get: async () => ({ docs: days.map((d) => snapshot(d)) }) }),
          };
        },
      }),
    }),
  } as unknown as Firestore;
}

describe("FirestoreMergeStatsStore expiry", () => {
  test("writes a counted close with an expireAt 400 days after it closed", async () => {
    const created: Record<string, unknown>[] = [];
    const ref = { collection: () => ({ doc: () => ref }) };
    const firestore = {
      collection: () => ({ doc: () => ref }),
      runTransaction: async (fn: (tx: unknown) => Promise<boolean>) =>
        fn({
          getAll: async () => [snapshot({}, false), snapshot({})],
          create: (_ref: unknown, data: Record<string, unknown>) => created.push(data),
          set: () => undefined,
        }),
    } as unknown as Firestore;

    expect(await new FirestoreMergeStatsStore(firestore).record(CLOSE)).toBe(true);
    expect(created).toHaveLength(1);
    expect((created[0]!.expireAt as Timestamp).toDate().toISOString()).toBe(
      "2027-11-12T10:15:00.000Z"
    );
  });

  test("reads totals and a year of daily counts without touching counted closes", async () => {
    const store = new FirestoreMergeStatsStore(
      firestoreWithoutMerges({ accountsClosed: 7, xlmStroops: "90000000" }, [
        { date: "2025-10-09", accountsClosed: 3 },
        { date: "2026-10-08", accountsClosed: 4 },
      ])
    );
    expect(await store.totals("mainnet")).toEqual({ accountsClosed: 7, xlmStroops: "90000000" });
    expect(await store.daily("mainnet", "2025-10-09")).toEqual([
      { date: "2025-10-09", accountsClosed: 3 },
      { date: "2026-10-08", accountsClosed: 4 },
    ]);
    await expect(store.recent("mainnet", 1)).rejects.toThrow("merges read");
  });
});
