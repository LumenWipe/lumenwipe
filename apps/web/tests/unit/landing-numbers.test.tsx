import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import LandingPage from "@/app/(marketing)/page";
import HeroConsole from "@/components/marketing/HeroConsole";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import StatsHero from "@/components/marketing/stats/StatsHero";
import { BASE_RESERVE_XLM, MINIMUM_BALANCE_RESERVES } from "@/lib/site/reserve";
import {
  monthYear,
  RESERVE_EXAMPLE,
  RESERVE_EXAMPLE_TOTAL,
  STATS,
  type SiteStat,
} from "@/lib/site/numbers";
import { LIVE_EXIT_PROTOCOLS } from "@/lib/site/status";
import type { FeedData } from "@/lib/stats";
import { renderMarketing } from "./fixtures/marketing";

const WEB = join(import.meta.dir, "..", "..");

afterEach(() => {
  setSystemTime();
});

function statBand(): HTMLElement {
  const root = renderMarketing(<LandingPage />);
  return root.querySelector("dl")!;
}

describe("landing numbers", () => {
  test("every stat has a dated source link or comes from the registry", () => {
    for (const stat of STATS as SiteStat[]) {
      if (stat.source.kind === "external") {
        expect(new URL(stat.source.href).protocol).toBe("https:");
        expect(stat.source.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(stat.source.asOf))).toBe(false);
      } else {
        expect(existsSync(join(WEB, "..", "..", stat.source.file))).toBe(true);
      }
    }
  });

  test("the band shows each stat with its source and as-of date, and nothing else", () => {
    const band = statBand();
    const values = [...band.querySelectorAll("dd.order-1")].map((dd) => dd.textContent);
    expect(values).toEqual(STATS.map((s) => s.value));
    for (const stat of STATS) {
      const label = within(band).getByText(stat.label);
      const group = label.parentElement!;
      if (stat.source.kind === "external") {
        expect(group.textContent).toContain(`As of ${monthYear(stat.source.asOf)}`);
        const link = within(group).getByRole("link");
        expect(link.getAttribute("href")).toBe(stat.source.href);
      } else {
        expect(group.textContent).toContain("From the contract registry");
      }
    }
  });

  test("the protocol count is computed from the registry", () => {
    expect(STATS.map((s) => s.value)).toContain(String(LIVE_EXIT_PROTOCOLS.length));
  });

  test("no unsourced or mixed-network figure remains", () => {
    const text = renderMarketing(<LandingPage />).textContent ?? "";
    expect(text).not.toContain("10M+");
    expect(text).not.toContain("1 + 0.5n");
    expect(text).not.toContain("DeFi protocols mapped");
    expect(text).not.toContain("accounts closed");
    expect(existsSync(join(WEB, "components", "marketing", "LiveStats.tsx"))).toBe(false);
  });

  test("the reserve rule reads in plain words", () => {
    expect(STATS[0]!.value).toBe(
      `${MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM} XLM plus ${BASE_RESERVE_XLM} per item`
    );
  });
});

describe("the reserve example", () => {
  test("is labelled an example and priced from the base reserve", () => {
    const root = renderMarketing(<LandingPage />);
    expect(within(root).getByText("Example account").className).toContain("text-fg-muted");
    expect(RESERVE_EXAMPLE_TOTAL).toBe(RESERVE_EXAMPLE.reduce((s, r) => s + r.xlm, 0));
    expect(RESERVE_EXAMPLE_TOTAL).toBe(10 * BASE_RESERVE_XLM);
    expect(root.textContent).toContain(`Total locked${RESERVE_EXAMPLE_TOTAL.toFixed(2)} XLM`);
  });

  test("the hero console is labelled an example with the same total", () => {
    render(<HeroConsole />);
    expect(screen.getByText(/Example account/).textContent).toContain(
      `${RESERVE_EXAMPLE_TOTAL.toFixed(2)} XLM total`
    );
  });
});

describe("footer", () => {
  test("the year is the current one", () => {
    setSystemTime(new Date("2031-03-01T00:00:00Z"));
    render(<MarketingFooter />);
    expect(screen.getByText(/© 2031 LumenWipe/)).toBeTruthy();
  });
});

describe("stats page", () => {
  const feed: FeedData = {
    recent: [],
    daily: [],
    totals: {
      mainnet: 3,
      testnet: 40,
      mainnetXlmStroops: "300000000",
      testnetXlmStroops: "4000000000",
    },
  };

  test("never adds testnet closes to the mainnet figure", () => {
    let now = 0;
    const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((step) => {
      now += 2000;
      step(now);
      return 0;
    });
    render(<StatsHero feed={feed} />);
    raf.mockRestore();
    const headline = screen.getByText("Accounts closed on mainnet").parentElement!;
    expect(headline.textContent).toContain("3Testnet, counted separately: 40");
    expect(screen.getByText("Mean XLM recovered per mainnet close")).toBeTruthy();
  });
});
