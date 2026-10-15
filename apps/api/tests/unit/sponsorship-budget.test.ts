import { describe, expect, test } from "bun:test";
import { SponsorshipBudget } from "@/fee-bump/sponsorship-budget";

const DAY = new Date("2026-10-15T08:00:00Z");
const NEXT_DAY = new Date("2026-10-16T00:00:00Z");

let hashes = 0;
function spend(source: string, key: string, fee: bigint, network = "testnet") {
  hashes += 1;
  return { network, source, key, fee, innerHash: `h${hashes}` };
}

describe("SponsorshipBudget", () => {
  test("allows spend up to each limit and refuses the stroop beyond it", () => {
    const budget = new SponsorshipBudget({ perSource: 300n, perKey: 1_000n, total: 5_000n });
    expect(budget.reserve(spend("A", "k", 200n), DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 100n), DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 1n), DAY)).toBe("source");
    expect(budget.reserve(spend("B", "k", 300n), DAY)).toBeNull();
  });

  test("limits a key across sources and the total across keys", () => {
    const budget = new SponsorshipBudget({ perSource: 1_000n, perKey: 500n, total: 800n });
    expect(budget.reserve(spend("A", "k1", 500n), DAY)).toBeNull();
    expect(budget.reserve(spend("B", "k1", 1n), DAY)).toBe("key");
    expect(budget.reserve(spend("C", "k2", 300n), DAY)).toBeNull();
    expect(budget.reserve(spend("D", "k3", 1n), DAY)).toBe("total");
  });

  test("a refused request records nothing", () => {
    const budget = new SponsorshipBudget({ perSource: 1_000n, perKey: 100n, total: 1_000n });
    expect(budget.reserve(spend("A", "k", 150n), DAY)).toBe("key");
    expect(budget.reserve(spend("A", "k", 100n), DAY)).toBeNull();
  });

  test("the same inner transaction is charged once", () => {
    const budget = new SponsorshipBudget({ perSource: 100n, perKey: 100n, total: 100n });
    const once = spend("A", "k", 100n);
    expect(budget.reserve(once, DAY)).toBeNull();
    expect(budget.reserve(once, DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 1n), DAY)).toBe("source");
  });

  test("each network keeps its own budget", () => {
    const budget = new SponsorshipBudget({ perSource: 100n, perKey: 100n, total: 100n });
    expect(budget.reserve(spend("A", "k", 100n, "testnet"), DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 100n, "mainnet"), DAY)).toBeNull();
    expect(budget.reserve(spend("B", "k2", 1n, "testnet"), DAY)).toBe("total");
  });

  test("a new UTC day starts every scope again, and an earlier clock reading does not", () => {
    const budget = new SponsorshipBudget({ perSource: 100n, perKey: 100n, total: 100n });
    expect(budget.reserve(spend("A", "k", 100n), DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 1n), DAY)).toBe("source");
    expect(budget.reserve(spend("A", "k", 100n), NEXT_DAY)).toBeNull();
    expect(budget.reserve(spend("A", "k", 1n), DAY)).toBe("source");
  });
});
