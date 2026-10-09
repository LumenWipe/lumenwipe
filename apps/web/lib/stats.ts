import type { MergeRecord, StatsFeed, StatsTotals } from "@lumenwipe/types";

export type { MergeRecord };

/** What `/api/stats` serves the browser: both networks' totals in one object. */
export interface StatsResult {
  testnet: number;
  mainnet: number;
  testnetXlmStroops: string;
  mainnetXlmStroops: string;
}

export interface DailyActivity {
  date: string;
  count: number;
}

/** What `/api/stats/feed` serves the browser: mainnet's activity plus both networks' totals. */
export interface FeedData {
  recent: MergeRecord[];
  daily: DailyActivity[];
  totals: StatsResult;
}

export function toStatsResult(testnet: StatsTotals, mainnet: StatsTotals): StatsResult {
  return {
    testnet: testnet.accountsClosed,
    mainnet: mainnet.accountsClosed,
    testnetXlmStroops: testnet.xlmRecoveredStroops,
    mainnetXlmStroops: mainnet.xlmRecoveredStroops,
  };
}

export function toFeedData(mainnetFeed: StatsFeed, testnet: StatsTotals): FeedData {
  return {
    recent: mainnetFeed.recent,
    daily: mainnetFeed.daily.map((d) => ({ date: d.date, count: d.accountsClosed })),
    totals: toStatsResult(testnet, mainnetFeed.totals),
  };
}
