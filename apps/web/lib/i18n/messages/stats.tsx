import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "Stats",
    description:
      "Live on-chain traction: accounts closed, XLM recovered, and every transaction hash verified on the Stellar blockchain.",
  },
  eyebrow: "On-chain activity",
  heading: "Real numbers. Verifiable on Stellar.",
  intro: (code: (text: string) => ReactNode): ReactNode => (
    <>
      {"Every transaction on this page is an"} {code("ACCOUNT_MERGE")}{" "}
      {"operation recorded on the Stellar blockchain. Click any hash to verify."}
    </>
  ),
  stale: "Data may be stale",
  verification: (code: (text: string) => ReactNode): ReactNode => (
    <>
      {
        "Each close counted here was completed through LumenWipe. Before being recorded, the backend confirms the transaction hash is a successful"
      }{" "}
      {code("ACCOUNT_MERGE")}
      {
        " on the Stellar blockchain - merges done outside LumenWipe are not included. Every row in the feed links directly to stellar.expert so you can verify each one independently."
      }
    </>
  ),
  explorer: "stellar.expert ↗",
  hero: {
    mainnet: "Accounts closed on mainnet",
    testnet: (count: string): string => `Testnet, counted separately: ${count}`,
    recovered: "XLM recovered on mainnet",
    recoveredSub: "From reserves released on-chain",
    average: "Avg per mainnet close",
    averageSub: "Mean XLM recovered per mainnet close",
  },
  heatmap: {
    title: "Activity - last 12 months",
    activeDays: (days: number): string => `${days} active days`,
    streak: (days: number): string => `${days}-day streak`,
    less: "Less",
    more: "More",
    region: "Activity heatmap, last 12 months",
    noCloses: "No closes",
    accountsClosed: (count: number): string => `${count} account${count !== 1 ? "s" : ""} closed`,
    moreCloses: (count: number): string => `+${count} more`,
    hint: "Hover a day to inspect",
  },
  chart: {
    title: (days: number): ReactNode => (
      <>
        {"Each close · last "}
        {days}
        {" days"}
      </>
    ),
    legend: "size = XLM recovered · gold = large close",
    label: "Constellation of account closes over time",
    empty: "No mainnet closes in this window yet",
  },
  strip: {
    title: "XLM distribution · each dot is one close",
    hint: "log scale · hover to verify",
    label: "Distribution of XLM recovered per close",
    empty: "No closes yet",
  },
  feed: {
    title: "Recent closes",
    sub: "mainnet · verified on-chain",
    columns: { when: "When", xlm: "XLM", hash: "TX hash" },
    empty: "No mainnet closes yet",
    verify: "Verify on stellar.expert",
    showing: (count: number): string =>
      `Showing last ${count} closes · each row links to the Stellar blockchain`,
    ago: {
      seconds: (n: number): string => `${n}s ago`,
      minutes: (n: number): string => `${n}m ago`,
      hours: (n: number): string => `${n}h ago`,
      days: (n: number): string => `${n}d ago`,
    },
  },
};

export type StatsPageCopy = typeof en;

export const STATS_PAGE: Record<Locale, StatsPageCopy> = { en };
