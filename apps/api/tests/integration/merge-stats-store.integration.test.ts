import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import type { MergeRecord } from "@lumenwipe/types";
import { FirestoreMergeStatsStore } from "@/stats/merge-stats-store";

// Runs only against the Firestore emulator, never a real project: start one and export
// FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8787) before `bun run test:integration`.
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

const firestore = EMULATOR ? new Firestore({ projectId: "lumenwipe-emulator" }) : null;

afterAll(async () => {
  await firestore?.terminate();
});

function freshStore(): FirestoreMergeStatsStore {
  return new FirestoreMergeStatsStore(firestore!, `stats-${randomBytes(6).toString("hex")}`);
}

function merge(overrides: Partial<MergeRecord> = {}): MergeRecord {
  return {
    txHash: randomBytes(32).toString("hex"),
    network: "mainnet",
    accountsClosed: 1,
    xlmStroops: "10000000",
    timestamp: "2026-10-08T10:00:00.000Z",
    ...overrides,
  };
}

describe.skipIf(!EMULATOR)("FirestoreMergeStatsStore (emulator)", () => {
  test("counts a hash once and leaves every counter untouched on a repeat", async () => {
    const store = freshStore();
    const m = merge();
    expect(await store.record(m)).toBe(true);
    expect(await store.record({ ...m, xlmStroops: "999" })).toBe(false);
    expect(await store.totals("mainnet")).toEqual({ accountsClosed: 1, xlmStroops: "10000000" });
    expect(await store.daily("mainnet", "2026-10-01")).toEqual([
      { date: "2026-10-08", accountsClosed: 1 },
    ]);
    expect(await store.recent("mainnet", 10)).toEqual([m]);
  });

  test("sums stroops exactly past 2^53", async () => {
    const store = freshStore();
    await store.record(merge({ xlmStroops: "9007199254740993" }));
    await store.record(merge({ xlmStroops: "9007199254740993" }));
    expect((await store.totals("mainnet")).xlmStroops).toBe("18014398509481986");
  });

  test("concurrent reports of one hash count it once", async () => {
    const store = freshStore();
    const m = merge();
    const results = await Promise.all(Array.from({ length: 8 }, () => store.record(m)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.totals("mainnet")).accountsClosed).toBe(1);
  });

  // Ten transactions contend for one totals doc; the emulator's retry backoff can pass 5 s.
  test("concurrent distinct closes all land in the totals", async () => {
    const store = freshStore();
    await Promise.all(Array.from({ length: 10 }, () => store.record(merge())));
    expect(await store.totals("mainnet")).toEqual({
      accountsClosed: 10,
      xlmStroops: "100000000",
    });
  }, 30_000);

  test("recent is newest first and limited; daily honours the start date", async () => {
    const store = freshStore();
    const old = merge({ timestamp: "2026-09-01T00:00:00.000Z" });
    const mid = merge({ timestamp: "2026-10-07T12:00:00.000Z", accountsClosed: 2 });
    const now = merge({ timestamp: "2026-10-08T09:00:00.000Z" });
    for (const m of [old, mid, now]) await store.record(m);

    expect((await store.recent("mainnet", 2)).map((r) => r.txHash)).toEqual([
      now.txHash,
      mid.txHash,
    ]);
    const daily = await store.daily("mainnet", "2026-10-01");
    expect(daily.sort((a, b) => a.date.localeCompare(b.date))).toEqual([
      { date: "2026-10-07", accountsClosed: 2 },
      { date: "2026-10-08", accountsClosed: 1 },
    ]);
  });

  test("networks never share counters", async () => {
    const store = freshStore();
    await store.record(merge({ network: "testnet" }));
    expect((await store.totals("mainnet")).accountsClosed).toBe(0);
    expect(await store.recent("mainnet", 10)).toEqual([]);
    expect((await store.totals("testnet")).accountsClosed).toBe(1);
  });
});
