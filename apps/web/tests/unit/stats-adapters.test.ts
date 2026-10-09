import { expect, test } from "bun:test";
import type { StatsFeed, StatsTotals } from "@lumenwipe/types";
import { toFeedData, toStatsResult } from "@/lib/stats";

const testnet: StatsTotals = { network: "testnet", accountsClosed: 40, xlmRecoveredStroops: "7" };
const mainnet: StatsTotals = {
  network: "mainnet",
  accountsClosed: 3,
  xlmRecoveredStroops: "18014398509481986",
};

test("both networks' API totals become the browser's single stats object", () => {
  expect(toStatsResult(testnet, mainnet)).toEqual({
    testnet: 40,
    mainnet: 3,
    testnetXlmStroops: "7",
    mainnetXlmStroops: "18014398509481986",
  });
});

test("the mainnet feed keeps its records and maps daily counts to the chart's shape", () => {
  const record = {
    txHash: "a".repeat(64),
    network: "mainnet" as const,
    accountsClosed: 1,
    xlmStroops: "45000000",
    timestamp: "2026-10-08T10:00:00.000Z",
  };
  const feed: StatsFeed = {
    totals: mainnet,
    recent: [record],
    daily: [
      { date: "2026-10-07", accountsClosed: 0 },
      { date: "2026-10-08", accountsClosed: 2 },
    ],
  };
  expect(toFeedData(feed, testnet)).toEqual({
    recent: [record],
    daily: [
      { date: "2026-10-07", count: 0 },
      { date: "2026-10-08", count: 2 },
    ],
    totals: toStatsResult(testnet, mainnet),
  });
});
