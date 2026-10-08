import { describe, expect, test } from "bun:test";
import type { MergeRecord, Network } from "@lumenwipe/types";
import { InMemoryMergeStatsStore, type MergeStatsStore } from "@/stats/merge-stats-store";
import type { VerifiedMerge } from "@/stats/merge-verification";
import { FEED_DAYS, StatsService, type MergeVerifier } from "@/stats/stats.service";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function verified(txHash: string, closedAt: string, stroops = "10000000"): VerifiedMerge {
  return { txHash, accountsClosed: 1, xlmStroops: stroops, closedAt: new Date(closedAt) };
}

function setup(opts: { chain?: Record<string, VerifiedMerge>; store?: MergeStatsStore } = {}) {
  const chain = opts.chain ?? {};
  const calls: Array<[string, Network]> = [];
  const verify: MergeVerifier = async (hash, network) => {
    calls.push([hash, network]);
    return chain[hash] ?? null;
  };
  const clock = { now: new Date("2026-10-08T12:00:00Z") };
  const store = opts.store ?? new InMemoryMergeStatsStore();
  const service = new StatsService(store, verify, () => clock.now);
  return { service, store, calls, clock };
}

describe("StatsService.record", () => {
  test("writes nothing for a transaction the chain does not confirm as a merge", async () => {
    const { service, store } = setup();
    expect(await service.record("testnet", HASH_A)).toBe("unverified");
    expect(await store.totals("testnet")).toEqual({ accountsClosed: 0, xlmStroops: "0" });
  });

  test("counts a verified close once, however many times it is reported", async () => {
    const { service } = setup({ chain: { [HASH_A]: verified(HASH_A, "2026-10-08T10:00:00Z") } });
    expect(await service.record("mainnet", HASH_A)).toBe("counted");
    expect(await service.record("mainnet", HASH_A)).toBe("duplicate");
    expect(await service.totals("mainnet")).toEqual({
      network: "mainnet",
      accountsClosed: 1,
      xlmRecoveredStroops: "10000000",
    });
  });

  test("verifies against the network the close is reported on", async () => {
    const { service, calls } = setup();
    await service.record("testnet", HASH_A);
    expect(calls).toEqual([[HASH_A, "testnet"]]);
  });

  test("keeps testnet and mainnet counts apart", async () => {
    const { service } = setup({ chain: { [HASH_A]: verified(HASH_A, "2026-10-08T10:00:00Z") } });
    await service.record("testnet", HASH_A);
    expect((await service.totals("mainnet")).accountsClosed).toBe(0);
    expect((await service.totals("testnet")).accountsClosed).toBe(1);
  });

  test("a new close is visible at once, not after the cache expires", async () => {
    const { service } = setup({
      chain: {
        [HASH_A]: verified(HASH_A, "2026-10-08T10:00:00Z"),
        [HASH_B]: verified(HASH_B, "2026-10-08T11:00:00Z"),
      },
    });
    await service.record("mainnet", HASH_A);
    expect((await service.totals("mainnet")).accountsClosed).toBe(1);
    expect((await service.feed("mainnet")).recent).toHaveLength(1);
    await service.record("mainnet", HASH_B);
    expect((await service.totals("mainnet")).accountsClosed).toBe(2);
    expect((await service.feed("mainnet")).recent.map((r) => r.txHash)).toEqual([HASH_B, HASH_A]);
  });
});

describe("StatsService.feed", () => {
  test("returns 365 zero-filled UTC days ending today, oldest first", async () => {
    const { service } = setup({
      chain: {
        [HASH_A]: verified(HASH_A, "2026-10-08T01:00:00Z"),
        [HASH_B]: verified(HASH_B, "2026-01-02T23:59:59Z"),
      },
    });
    await service.record("mainnet", HASH_A);
    await service.record("mainnet", HASH_B);

    const { daily } = await service.feed("mainnet");
    expect(daily).toHaveLength(FEED_DAYS);
    expect(daily[0]!.date).toBe("2025-10-09");
    expect(daily.at(-1)).toEqual({ date: "2026-10-08", accountsClosed: 1 });
    expect(daily.find((d) => d.date === "2026-01-02")!.accountsClosed).toBe(1);
    expect(daily.reduce((n, d) => n + d.accountsClosed, 0)).toBe(2);
  });

  test("drops closes older than the window from the daily series but not the totals", async () => {
    const { service } = setup({ chain: { [HASH_A]: verified(HASH_A, "2024-01-01T00:00:00Z") } });
    await service.record("mainnet", HASH_A);
    const feed = await service.feed("mainnet");
    expect(feed.daily.every((d) => d.accountsClosed === 0)).toBe(true);
    expect(feed.totals.accountsClosed).toBe(1);
  });

  test("does not cache a failed read", async () => {
    let failing = true;
    const inner = new InMemoryMergeStatsStore();
    const store: MergeStatsStore = {
      record: (m: MergeRecord) => inner.record(m),
      totals: (n) => (failing ? Promise.reject(new Error("store down")) : inner.totals(n)),
      recent: (n, l) => inner.recent(n, l),
      daily: (n, f) => inner.daily(n, f),
    };
    const { service } = setup({ store });
    await expect(service.totals("mainnet")).rejects.toThrow("store down");
    failing = false;
    expect((await service.totals("mainnet")).accountsClosed).toBe(0);
  });

  test("serves from cache within the TTL and re-reads after it", async () => {
    let reads = 0;
    const inner = new InMemoryMergeStatsStore();
    const store: MergeStatsStore = {
      record: (m) => inner.record(m),
      totals: (n) => {
        reads += 1;
        return inner.totals(n);
      },
      recent: (n, l) => inner.recent(n, l),
      daily: (n, f) => inner.daily(n, f),
    };
    const { service, clock } = setup({ store });
    await service.totals("mainnet");
    await service.totals("mainnet");
    expect(reads).toBe(1);
    clock.now = new Date(clock.now.getTime() + 5_001);
    await service.totals("mainnet");
    expect(reads).toBe(2);
  });
});
