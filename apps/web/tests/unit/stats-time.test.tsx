import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";
import CalendarHeatmap from "@/components/marketing/stats/CalendarHeatmap";
import ConstellationChart from "@/components/marketing/stats/ConstellationChart";
import DistributionStrip from "@/components/marketing/stats/DistributionStrip";
import RecentFeed from "@/components/marketing/stats/RecentFeed";
import StatsHero from "@/components/marketing/stats/StatsHero";
import type { FeedData } from "@/hooks/useFeed";

const FEED: FeedData = {
  recent: [
    {
      txHash: "a".repeat(64),
      network: "mainnet",
      accountsClosed: 1,
      xlmStroops: "15000000",
      timestamp: "2026-03-10T12:00:00.000Z",
    },
    {
      txHash: "b".repeat(64),
      network: "mainnet",
      accountsClosed: 1,
      xlmStroops: "450000000",
      timestamp: "2026-02-02T08:00:00.000Z",
    },
  ],
  daily: [
    { date: "2026-02-02", count: 1 },
    { date: "2026-03-10", count: 1 },
  ],
  totals: { testnet: 4, mainnet: 2, testnetXlmStroops: "0", mainnetXlmStroops: "465000000" },
};

const COMPONENTS: [string, ComponentType<{ feed: FeedData | null }>][] = [
  ["ConstellationChart", ConstellationChart],
  ["CalendarHeatmap", CalendarHeatmap],
  ["DistributionStrip", DistributionStrip],
  ["RecentFeed", RecentFeed],
  ["StatsHero", StatsHero],
];

afterEach(() => {
  cleanup();
  setSystemTime();
});

for (const [name, Component] of COMPONENTS) {
  test(`${name} › server markup does not depend on the current time`, () => {
    setSystemTime(new Date("2026-03-15T00:00:00Z"));
    const first = renderToString(<Component feed={FEED} />);
    setSystemTime(new Date("2027-08-01T13:37:00Z"));
    expect(renderToString(<Component feed={FEED} />)).toBe(first);
  });
}

async function axisLabelsAt(now: string): Promise<{ labels: string[]; dots: number }> {
  setSystemTime(new Date(now));
  const { container } = render(<ConstellationChart feed={FEED} />);
  await act(async () => {});
  const labels = [...container.querySelectorAll("[data-axis-label]")].map((l) => l.textContent);
  const dots = container.querySelectorAll("circle[fill^='hsl']").length;
  cleanup();
  return { labels: labels.map((l) => l ?? ""), dots };
}

test("ConstellationChart › after mount the window ends at the current time", async () => {
  expect(await axisLabelsAt("2026-03-15T00:00:00Z")).toEqual({ labels: ["Feb", "Mar"], dots: 2 });
  expect(await axisLabelsAt("2026-05-20T00:00:00Z")).toEqual({ labels: ["Apr", "May"], dots: 0 });
});
