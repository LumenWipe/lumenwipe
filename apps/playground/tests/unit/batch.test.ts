import { describe, expect, test } from "bun:test";
import {
  BLOCKED_MEMBER_SELECTION,
  DEFAULT_BATCH_MEMBERS,
  LIGHT_SELECTION,
  MAX_BATCH_SIZE,
  MAX_ESTIMATED_SECONDS,
  MAX_SESSION_XLM,
  MAX_SUB_ENTRIES,
  demoFundingXlm,
  parseBatch,
  parseBatchSize,
  SCENARIOS,
  resolvePlan,
  validateBatch,
  validateSelection,
  type ScenarioCost,
  type ScenarioDefinition,
  type ScenarioSelection,
} from "@/lib/scenarios";

// A batch is two or three ordinary sessions: the visitor's accounts plus the one the server adds,
// which the close reports blocked. Each member must pass the validator on its own, and the batch
// as a whole must stay inside the caps of a single session.

const pick = (...scenarios: ScenarioSelection["scenarios"]): ScenarioSelection => ({ scenarios });
const DATA = pick({ id: "data-entries", params: { count: 3 } });

function refusal(members: readonly ScenarioSelection[]): string {
  const result = validateBatch(members);
  if (result.ok) throw new Error("expected the batch to be refused");
  return result.message;
}

describe("validateBatch", () => {
  test("the defaults validate, with the blocked account added last", () => {
    for (const size of [2, 3] as const) {
      const result = validateBatch(DEFAULT_BATCH_MEMBERS[size]);
      if (!result.ok) throw new Error(result.message);
      expect(result.batch.members).toHaveLength(size);
      expect(result.batch.blockedIndex).toBe(size - 1);
      expect(result.batch.members[size - 1]!.selection).toEqual(
        resolvePlan(BLOCKED_MEMBER_SELECTION).selection
      );
      expect(result.batch.members[size - 1]!.expectation.resolutions).toEqual([
        { blocker: "sponsorship_claimable_balance_unrevocable", kind: "claim_sponsored_balance" },
      ]);
    }
  });

  test("a batch of four is rejected", () => {
    expect(refusal([LIGHT_SELECTION, DATA, LIGHT_SELECTION])).toBe(
      `A batch can close at most ${MAX_BATCH_SIZE} accounts.`
    );
  });

  test("a batch of the blocked account alone is rejected", () => {
    expect(refusal([])).toBe("A batch closes at least 2 accounts.");
  });

  test("members that each fit but together exceed 50 XLM are rejected", () => {
    // Each fits a session on its own; with the blocked account the three sum past the cap.
    const heavy = pick(
      { id: "lwdemo-holding", params: {} },
      { id: "junk-airdrops", params: { tokens: 2 } },
      { id: "stablecoin-swaps", params: { tokens: 2 } },
      { id: "stale-offers", params: { count: 5 } }
    );
    const swaps = pick(
      { id: "lwdemo-holding", params: {} },
      { id: "stablecoin-swaps", params: { tokens: 2 } },
      { id: "dispositions", params: { lwcoin: 2, lwgem: 2 } }
    );
    const costs = [heavy, swaps, BLOCKED_MEMBER_SELECTION].map((s) => resolvePlan(s).cost.xlm);
    for (const own of costs) expect(own).toBeLessThanOrEqual(MAX_SESSION_XLM);
    const total = costs.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(MAX_SESSION_XLM);
    expect(refusal([heavy, swaps])).toBe(
      `This batch needs about ${total} test XLM; a batch can use at most ${MAX_SESSION_XLM}.`
    );
  });

  // The classic registry cannot reach these caps inside the scenario cap, so one scenario's cost
  // is raised to a value that fits a session but not two of them.
  function inflated(cost: Partial<ScenarioCost>): ScenarioDefinition[] {
    return SCENARIOS.map((def) =>
      def.id !== "data-entries"
        ? def
        : {
            ...def,
            build: (params, context) => {
              const built = def.build(params, context);
              return built.ok
                ? { ok: true, build: { ...built.build, cost: { ...built.build.cost, ...cost } } }
                : built;
            },
          }
    );
  }

  test("members whose summed entries pass the cap are rejected", () => {
    const registry = inflated({ subEntries: 20 });
    expect(validateSelection(DATA, { registry }).ok).toBe(true);
    expect(validateBatch([DATA], { registry }).ok).toBe(true);
    const result = validateBatch([DATA, DATA], { registry });
    expect(result.ok ? null : result.message).toBe(
      `This batch adds 41 entries across its accounts; the limit is ${MAX_SUB_ENTRIES}.`
    );
  });

  test("members whose summed duration passes the cap are rejected", () => {
    const registry = inflated({ seconds: 200 });
    expect(validateSelection(DATA, { registry }).ok).toBe(true);
    const result = validateBatch([DATA, DATA], { registry });
    expect(result.ok ? null : result.message).toMatch(
      new RegExp(
        `^This batch would take about \\d+ minutes; a demo is limited to ${MAX_ESTIMATED_SECONDS / 60}\\.$`
      )
    );
  });

  test("an exchange, protocol or blocked member is refused as a closable account", () => {
    expect(refusal([pick({ id: "exchange-close", params: {} })])).toMatch(
      /^Account 1: .+ cannot be part of a batch: a batch closes classic accounts only\.$/
    );
    expect(
      refusal([pick({ id: "fee-bump", params: {} }, { id: "data-entries", params: { count: 1 } })])
    ).toContain("a batch closes classic accounts only.");
    expect(refusal([pick({ id: "allowances", params: {} })])).toContain(
      "a batch closes classic accounts only."
    );
    expect(refusal([BLOCKED_MEMBER_SELECTION])).toBe(
      "Account 1: an account that blocks its own close cannot be added: the batch adds one itself."
    );
  });

  test("a member the validator refuses on its own is refused with its position", () => {
    expect(refusal([LIGHT_SELECTION, pick({ id: "data-entries", params: { count: 9 } })])).toMatch(
      /^Account 2: /
    );
  });

  test("the funding is every member's own funding added up exactly", () => {
    const result = validateBatch(DEFAULT_BATCH_MEMBERS[3]);
    if (!result.ok) throw new Error(result.message);
    const sum = result.batch.members.reduce(
      (total, plan) => total + Number(demoFundingXlm(plan.cost)),
      0
    );
    expect(result.batch.fundingXlm).toBe(sum.toFixed(7));
  });
});

describe("parseBatch and parseBatchSize", () => {
  test("reads members shaped like selections, and nothing else", () => {
    expect(parseBatch({ members: [LIGHT_SELECTION] })).toEqual([LIGHT_SELECTION]);
    expect(parseBatch({ members: [{ scenarios: [{ id: "nope" }] }] })).toBeNull();
    expect(parseBatch({ members: "all" })).toBeNull();
    expect(parseBatch(null)).toBeNull();
    expect(parseBatch({ members: Array.from({ length: MAX_BATCH_SIZE + 1 }, () => DATA) })).toBe(
      null
    );
  });

  test("a batch link names two or three accounts, nothing else", () => {
    expect(parseBatchSize("2")).toBe(2);
    expect(parseBatchSize("3")).toBe(3);
    for (const value of [null, "", "1", "4", "02", "3 "]) expect(parseBatchSize(value)).toBeNull();
  });
});
