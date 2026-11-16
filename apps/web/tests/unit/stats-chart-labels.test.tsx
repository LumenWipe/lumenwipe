import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import ConstellationChart from "@/components/marketing/stats/ConstellationChart";
import DistributionStrip from "@/components/marketing/stats/DistributionStrip";
import type { FeedData } from "@/hooks/useFeed";

const STATS_DIR = join(import.meta.dir, "..", "..", "components", "marketing", "stats");

const FEED: FeedData = {
  recent: [
    {
      txHash: "c".repeat(64),
      network: "mainnet",
      accountsClosed: 1,
      xlmStroops: "15000000",
      timestamp: "2026-03-10T12:00:00.000Z",
    },
  ],
  daily: [{ date: "2026-03-10", count: 1 }],
  totals: { testnet: 0, mainnet: 1, testnetXlmStroops: "0", mainnetXlmStroops: "15000000" },
};

const EMPTY: FeedData = { ...FEED, recent: [], daily: [] };

afterEach(() => {
  cleanup();
  setSystemTime();
});

for (const [name, Chart] of [
  ["ConstellationChart", ConstellationChart],
  ["DistributionStrip", DistributionStrip],
] as const) {
  for (const [state, feed] of [
    ["with closes", FEED],
    ["empty", EMPTY],
  ] as const) {
    test(`${name} › ${state}, every label is HTML on the type scale`, async () => {
      setSystemTime(new Date("2026-03-15T00:00:00Z"));
      const { container } = render(<Chart feed={feed} />);
      await act(async () => {});
      expect(container.querySelectorAll("svg text")).toHaveLength(0);
      const labels = [...container.querySelectorAll("[data-axis-label]")];
      if (state === "with closes") expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) expect(label.classList.contains("text-caption")).toBe(true);
      if (state === "empty") {
        const notice = [...container.querySelectorAll("p")].find((p) =>
          /^No .*yet$/.test(p.textContent ?? "")
        );
        expect(notice?.classList.contains("text-caption")).toBe(true);
      }
    });
  }
}

test("ConstellationChart › each month label has a tick on the axis", async () => {
  setSystemTime(new Date("2026-03-15T00:00:00Z"));
  const { container } = render(<ConstellationChart feed={FEED} />);
  await act(async () => {});
  expect(container.querySelectorAll("[data-axis-tick]")).toHaveLength(
    container.querySelectorAll("[data-axis-label]").length
  );
});

test("no stats component sets a font size of its own", () => {
  for (const file of readdirSync(STATS_DIR)) {
    expect(readFileSync(join(STATS_DIR, file), "utf8"), file).not.toMatch(/fontSize/);
  }
});
