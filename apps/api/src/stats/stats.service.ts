import { Inject, Injectable } from "@nestjs/common";
import type { DailyActivity, Network, StatsFeed, StatsTotals } from "@lumenwipe/types";
import { MERGE_STATS_STORE, utcDate, type MergeStatsStore } from "./merge-stats-store";
import { verifyMerge, type VerifiedMerge } from "./merge-verification";

export const MERGE_VERIFIER = Symbol("MERGE_VERIFIER");
export const STATS_CLOCK = Symbol("STATS_CLOCK");

export type MergeVerifier = (txHash: string, network: Network) => Promise<VerifiedMerge | null>;
export type Clock = () => Date;

export const FEED_RECENT_LIMIT = 50;
export const FEED_DAYS = 365;
const TOTALS_TTL_MS = 5_000;
const FEED_TTL_MS = 30_000;

export type RecordOutcome = "counted" | "duplicate" | "unverified";

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

@Injectable()
export class StatsService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    @Inject(MERGE_STATS_STORE) private readonly store: MergeStatsStore,
    @Inject(MERGE_VERIFIER) private readonly verify: MergeVerifier,
    @Inject(STATS_CLOCK) private readonly now: Clock
  ) {}

  /** Counts a close only after confirming it on-chain; the caller's word is never enough. */
  async record(network: Network, txHash: string): Promise<RecordOutcome> {
    const merge = await this.verify(txHash, network);
    if (!merge) return "unverified";

    const counted = await this.store.record({
      txHash: merge.txHash,
      network,
      accountsClosed: merge.accountsClosed,
      xlmStroops: merge.xlmStroops,
      timestamp: merge.closedAt.toISOString(),
    });
    if (!counted) return "duplicate";

    this.cache.delete(`totals:${network}`);
    this.cache.delete(`feed:${network}`);
    return "counted";
  }

  totals(network: Network): Promise<StatsTotals> {
    return this.cached(`totals:${network}`, TOTALS_TTL_MS, () => this.readTotals(network));
  }

  feed(network: Network): Promise<StatsFeed> {
    return this.cached(`feed:${network}`, FEED_TTL_MS, async () => {
      const days = this.lastDays(FEED_DAYS);
      const [totals, recent, counts] = await Promise.all([
        this.readTotals(network),
        this.store.recent(network, FEED_RECENT_LIMIT),
        this.store.daily(network, days[0]!),
      ]);
      const byDate = new Map(counts.map((d) => [d.date, d.accountsClosed]));
      const daily: DailyActivity[] = days.map((date) => ({
        date,
        accountsClosed: byDate.get(date) ?? 0,
      }));
      return { totals, recent, daily };
    });
  }

  private async readTotals(network: Network): Promise<StatsTotals> {
    const { accountsClosed, xlmStroops } = await this.store.totals(network);
    return { network, accountsClosed, xlmRecoveredStroops: xlmStroops };
  }

  private lastDays(count: number): string[] {
    const today = this.now();
    const days: string[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(utcDate(d));
    }
    return days;
  }

  /** A failed read is evicted at once, so an outage is never cached as an answer. */
  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const at = this.now().getTime();
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > at) return hit.value;

    const value = load();
    this.cache.set(key, { expiresAt: at + ttlMs, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }
}

export const defaultMergeVerifier: MergeVerifier = (txHash, network) =>
  verifyMerge(txHash, network);
