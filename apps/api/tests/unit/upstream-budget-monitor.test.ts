import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import budgetsFile from "../../scripts/monitors/upstream-budgets.json";
import { main, type ReadDays } from "../../scripts/monitors/upstream-budget";
import {
  budgetUse,
  monthToDate,
  overBudget,
  parseBudgets,
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
    expect(overBudget({ provider: "p", used: 700, budget: 1000 })).toBe(true);
    expect(overBudget({ provider: "p", used: 699, budget: 1000 })).toBe(false);
    expect(overBudget({ provider: "p", used: 1, budget: 0 })).toBe(true);
    expect(overBudget({ provider: "p", used: 0, budget: 0 })).toBe(false);
  });
});

describe("main", () => {
  const dir = mkdtempSync(join(tmpdir(), "upstream-budget-"));
  const realWrite = { out: process.stdout.write, err: process.stderr.write };
  const saved = { output: process.env.GITHUB_OUTPUT, project: process.env.FIRESTORE_PROJECT_ID };
  let run = 0;

  beforeAll(() => {
    delete process.env.FIRESTORE_PROJECT_ID;
  });

  afterEach(() => {
    process.stdout.write = realWrite.out;
    process.stderr.write = realWrite.err;
  });

  afterAll(() => {
    for (const [key, value] of [
      ["GITHUB_OUTPUT", saved.output],
      ["FIRESTORE_PROJECT_ID", saved.project],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function check(options: Parameters<typeof main>[0]) {
    const output = join(dir, `output-${++run}`);
    writeFileSync(output, "");
    process.env.GITHUB_OUTPUT = output;
    let printed = "";
    const capture = (chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    const code = await main(options);
    process.stdout.write = realWrite.out;
    process.stderr.write = realWrite.err;
    return { code, status: /status=(\w+)/.exec(readFileSync(output, "utf8"))?.[1], printed };
  }

  const NOW = new Date("2026-11-19T06:00:00Z");

  test("reads only this month's dates, and a month under budget is clean", async () => {
    let asked: string[] = [];
    const read: ReadDays = async (dates) => {
      asked = dates;
      return [day("2026-11-02", { mainnet: { rpc: 699 } })];
    };
    const r = await check({ read, now: NOW, budgets: ENTRIES });
    expect(asked[0]).toBe("2026-11-01");
    expect(asked.at(-1)).toBe("2026-11-19");
    expect(r).toMatchObject({ code: 0, status: "clean" });
    expect(r.printed).toContain("rpc main: 699 of 1000 requests this month (69 percent)");
  });

  test("an upstream at 70 percent is a finding that names the runbook", async () => {
    const read: ReadDays = async () => [day("2026-11-02", { mainnet: { rpc: 700 } })];
    const r = await check({ read, now: NOW, budgets: ENTRIES });
    expect(r).toMatchObject({ code: 1, status: "finding" });
    expect(r.printed).toContain(
      "::error::rpc main: 700 of 1000 requests this month (70 percent), at or past 70 percent"
    );
    expect(r.printed).toContain("docs/runbooks/provider-quotas.mdx");
  });

  test("counts that cannot be read are incomplete, never clean", async () => {
    const read: ReadDays = async () => {
      throw new Error("PERMISSION_DENIED");
    };
    const r = await check({ read, now: NOW, budgets: ENTRIES });
    expect(r).toMatchObject({ code: 1, status: "incomplete" });
    expect(r.printed).toContain("::error::incomplete read, not a finding: PERMISSION_DENIED");
  });

  test("without a project to read, the check is incomplete", async () => {
    const r = await check({ now: NOW, budgets: ENTRIES });
    expect(r).toMatchObject({ code: 1, status: "incomplete" });
    expect(r.printed).toContain("FIRESTORE_PROJECT_ID is not set");
  });

  test("a budgets file that misses an upstream is incomplete", async () => {
    const r = await check({ read: async () => [], now: NOW, budgets: ENTRIES.slice(1) });
    expect(r).toMatchObject({ code: 1, status: "incomplete" });
  });
});
