import { describe, expect, test } from "bun:test";
import budgetsFile from "@/config/upstream-budgets.json";
import {
  budgetUse,
  monthToDate,
  overBudget,
  parseBudgets,
  percentUsed,
  type BudgetEntry,
  type UsageDay,
} from "@/lib/monitors/upstream-budget";

const ENTRIES: BudgetEntry[] = [
  { provider: "rpc main", networks: ["mainnet"], upstreams: ["rpc"], monthlyRequests: 1000 },
  { provider: "rpc test", networks: ["testnet"], upstreams: ["rpc"], monthlyRequests: 1000 },
  {
    provider: "horizon main",
    networks: ["mainnet"],
    upstreams: ["horizon", "paths"],
    monthlyRequests: 1000,
  },
  {
    provider: "horizon test",
    networks: ["testnet"],
    upstreams: ["horizon", "paths"],
    monthlyRequests: 1000,
  },
  {
    provider: "shared keys",
    networks: ["mainnet", "testnet"],
    upstreams: ["indexer", "soroswap"],
    monthlyRequests: 1000,
  },
  {
    provider: "mainnet only",
    networks: ["mainnet"],
    upstreams: ["defi", "xbull"],
    monthlyRequests: 1000,
  },
  { provider: "unused", networks: ["testnet"], upstreams: ["defi", "xbull"], monthlyRequests: 0 },
];

const day = (date: string, counts: Record<string, Record<string, number>>): UsageDay => ({
  date,
  counts: Object.fromEntries(
    Object.entries(counts).map(([network, byUpstream]) => [
      network,
      Object.fromEntries(
        Object.entries(byUpstream).map(([upstream, requests]) => [
          upstream,
          { requests, rate_limited: 999 },
        ])
      ),
    ])
  ),
});

const used = (days: UsageDay[]) =>
  Object.fromEntries(budgetUse(ENTRIES, days).uses.map((u) => [u.provider, u.used]));

describe("budgets", () => {
  test("the committed budgets cover every upstream on every network exactly once", () => {
    expect(() => parseBudgets(budgetsFile)).not.toThrow();
  });

  test("an upstream with no budget, one budgeted twice, or a malformed entry is refused", () => {
    expect(() => parseBudgets(ENTRIES.slice(1))).toThrow("mainnet/rpc has no budget");
    expect(() => parseBudgets([...ENTRIES, ENTRIES[0]])).toThrow(
      "mainnet/rpc is budgeted twice: rpc main and rpc main"
    );
    expect(() => parseBudgets([{ ...ENTRIES[0], monthlyRequests: 1.5 }, ...ENTRIES])).toThrow(
      "monthlyRequests"
    );
    expect(() => parseBudgets([{ ...ENTRIES[0], upstreams: ["explorer"] }])).toThrow(
      "unknown upstream: explorer"
    );
    expect(() => parseBudgets({})).toThrow("must be an array");
  });
});

describe("month to date", () => {
  test("runs from the first of the UTC month through today", () => {
    expect(monthToDate(new Date("2026-11-03T23:59:00Z"))).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(monthToDate(new Date("2026-12-01T00:00:00Z"))).toEqual(["2026-12-01"]);
  });
});

describe("use", () => {
  test("only requests count, summed over days and over the upstreams sharing a quota", () => {
    const totals = used([
      day("2026-11-01", { mainnet: { horizon: 10, paths: 5, rpc: 7 } }),
      day("2026-11-02", { mainnet: { horizon: 1 }, testnet: { indexer: 3 } }),
    ]);
    expect(totals["horizon main"]).toBe(16);
    expect(totals["rpc main"]).toBe(7);
    expect(totals["shared keys"]).toBe(3);
    expect(totals["horizon test"]).toBe(0);
  });

  test("a request under the unknown network is charged to every network's quota", () => {
    const totals = used([day("2026-11-01", { unknown: { horizon: 6 } })]);
    expect(totals["horizon main"]).toBe(6);
    expect(totals["horizon test"]).toBe(6);
  });

  test("an upstream the API no longer calls is set apart, not counted", () => {
    const { unbudgeted } = budgetUse(ENTRIES, [
      day("2026-11-01", { mainnet: { explorer: 40 }, testnet: { explorer: 2 } }),
    ]);
    expect(unbudgeted).toEqual(["mainnet/explorer", "testnet/explorer"]);
  });

  test("70 percent is a finding, just under it is not, and any use of an unused upstream is", () => {
    expect(overBudget({ used: 700, budget: 1000 })).toBe(true);
    expect(overBudget({ used: 699, budget: 1000 })).toBe(false);
    expect(overBudget({ used: 1, budget: 0 })).toBe(true);
    expect(overBudget({ used: 0, budget: 0 })).toBe(false);
  });

  test("the percentage is rounded down, and any use of a budget of 0 reads as 100", () => {
    expect(percentUsed({ used: 699, budget: 1000 })).toBe(69);
    expect(percentUsed({ used: 1, budget: 0 })).toBe(100);
    expect(percentUsed({ used: 0, budget: 0 })).toBe(0);
  });
});
