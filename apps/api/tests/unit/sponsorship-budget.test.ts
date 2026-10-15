import { describe, expect, test } from "bun:test";
import { SponsorshipBudget } from "@/fee-bump/sponsorship-budget";

const DAY = new Date("2026-10-15T08:00:00Z");
const NEXT_DAY = new Date("2026-10-16T00:00:00Z");

describe("SponsorshipBudget", () => {
  test("allows spend up to each limit and refuses the stroop beyond it", () => {
    const budget = new SponsorshipBudget({ perSource: 300n, perKey: 1_000n, total: 5_000n });
    expect(budget.reserve("A", "k", 200n, DAY)).toBeNull();
    expect(budget.reserve("A", "k", 100n, DAY)).toBeNull();
    expect(budget.reserve("A", "k", 1n, DAY)).toBe("source");
    expect(budget.reserve("B", "k", 300n, DAY)).toBeNull();
  });

  test("limits a key across sources and the total across keys", () => {
    const budget = new SponsorshipBudget({ perSource: 1_000n, perKey: 500n, total: 800n });
    expect(budget.reserve("A", "k1", 500n, DAY)).toBeNull();
    expect(budget.reserve("B", "k1", 1n, DAY)).toBe("key");
    expect(budget.reserve("C", "k2", 300n, DAY)).toBeNull();
    expect(budget.reserve("D", "k3", 1n, DAY)).toBe("total");
  });

  test("a refused request records nothing", () => {
    const budget = new SponsorshipBudget({ perSource: 1_000n, perKey: 100n, total: 1_000n });
    expect(budget.reserve("A", "k", 150n, DAY)).toBe("key");
    expect(budget.reserve("A", "k", 100n, DAY)).toBeNull();
  });

  test("a new UTC day starts every scope again", () => {
    const budget = new SponsorshipBudget({ perSource: 100n, perKey: 100n, total: 100n });
    expect(budget.reserve("A", "k", 100n, DAY)).toBeNull();
    expect(budget.reserve("A", "k", 1n, DAY)).toBe("source");
    expect(budget.reserve("A", "k", 100n, NEXT_DAY)).toBeNull();
  });
});
