import { describe, expect, test } from "bun:test";
import {
  ALLOWANCE_FEE_ESTIMATE_XLM,
  BASE_RESERVE_XLM,
  MAX_ESTIMATED_SECONDS,
  MAX_SCENARIOS,
  MAX_SESSION_XLM,
  MAX_SOROBAN_TRANSACTIONS,
  MAX_SUB_ENTRIES,
  FULL_SELECTION,
  SCENARIOS,
  STANDARD_SELECTION,
  parseSelection,
  resolvePlan,
  validateSelection,
  type ScenarioCost,
  type ScenarioDefinition,
  type ScenarioId,
  type ScenarioSelection,
} from "@/lib/scenarios";

const pick = (...scenarios: ScenarioSelection["scenarios"]): ScenarioSelection => ({ scenarios });

/** A scenario with every parameter at its minimum or its maximum. */
const at = (def: ScenarioDefinition, end: "min" | "max") => ({
  id: def.id,
  params: Object.fromEntries(Object.entries(def.params).map(([n, s]) => [n, s[end]])),
});

/** Every way to keep `size` of `count` indexes, from `from` on. */
const subsets = (count: number, from: number, size: number): number[][] =>
  size === 0
    ? [[]]
    : Array.from({ length: count - from }, (_, i) => from + i).flatMap((first) =>
        subsets(count, first + 1, size - 1).map((rest) => [first, ...rest])
      );

/** Largest selections (eight scenarios at their maximum) that fit every rule and cap, and those
 *  the XLM cap and the contract-transaction cap refuse. Pinned so a cost change shows up here. */
const FITTED_AT_MAX = 2382;
const OVER_XLM_AT_MAX = 3830;
const OVER_SOROBAN_AT_MAX = 718;

function messageOf(selection: ScenarioSelection, registry?: readonly ScenarioDefinition[]): string {
  const result = validateSelection(selection, { registry });
  if (result.ok) throw new Error("expected the selection to be refused");
  return result.message;
}

/** A one-step scenario with the given cost, standing in for scenarios not built yet. */
function synthetic(id: ScenarioId, cost: Partial<ScenarioCost>): ScenarioDefinition {
  return {
    id,
    featureSet: "classic",
    label: "Synthetic",
    description: "A test-only scenario.",
    params: {},
    heldAssets: () => [],
    requiresAnyOf: [],
    conflicts: [],
    build: () => ({
      ok: true,
      build: {
        steps: [
          {
            order: 50,
            step: {
              id: "ADD_SIGNER",
              label: "x",
              nodes: [],
              balances: [],
              action: { kind: "add_signer" },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: 0,
          dataEntries: 0,
          signers: 0,
          closeOperations: 1,
          operationTypes: ["setOptions"],
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
        },
        cost: {
          xlm: 0,
          classicTransactions: 1,
          sorobanTransactions: 0,
          seconds: 0,
          subEntries: 0,
          closeGroups: 0,
          sorobanExits: 0,
          ...cost,
        },
      },
    }),
  };
}

describe("the safety caps", () => {
  const cases: [string, Partial<ScenarioCost>, string][] = [
    [
      "sub-entries",
      { subEntries: MAX_SUB_ENTRIES + 1 },
      `This selection adds ${MAX_SUB_ENTRIES + 1} entries to the account; the limit is ${MAX_SUB_ENTRIES}.`,
    ],
    [
      "XLM",
      { xlm: MAX_SESSION_XLM },
      `This selection needs about ${MAX_SESSION_XLM + 1} test XLM; a demo can use at most ${MAX_SESSION_XLM}.`,
    ],
    [
      "Soroban transactions",
      { sorobanTransactions: MAX_SOROBAN_TRANSACTIONS + 1 },
      `This selection needs ${MAX_SOROBAN_TRANSACTIONS + 1} contract transactions; the limit is ${MAX_SOROBAN_TRANSACTIONS}.`,
    ],
    [
      "duration",
      { seconds: MAX_ESTIMATED_SECONDS },
      "This selection would take about 7 minutes; a demo is limited to 6.",
    ],
  ];
  for (const [name, cost, message] of cases) {
    test(`a selection over the ${name} cap is refused in plain language`, () => {
      const registry = [synthetic("forgotten-signer", cost)];
      expect(messageOf(pick({ id: "forgotten-signer", params: {} }), registry)).toBe(message);
    });
  }

  test("a selection exactly at every cap is accepted", () => {
    // The base plan adds 1 XLM and 13 seconds of its own.
    const atCap = synthetic("forgotten-signer", {
      subEntries: MAX_SUB_ENTRIES,
      xlm: MAX_SESSION_XLM - 1,
      sorobanTransactions: MAX_SOROBAN_TRANSACTIONS,
      seconds: MAX_ESTIMATED_SECONDS - 13,
    });
    const result = validateSelection(pick({ id: "forgotten-signer", params: {} }), {
      registry: [atCap],
    });
    expect(result.ok).toBe(true);
  });

  test(`at most ${MAX_SCENARIOS} scenarios`, () => {
    const many = Array.from({ length: MAX_SCENARIOS + 1 }, () => ({
      id: "forgotten-signer" as const,
      params: {},
    }));
    expect(messageOf({ scenarios: many })).toBe(
      `A demo can include at most ${MAX_SCENARIOS} scenarios.`
    );
  });

  test("the largest real selections stay inside every cap", () => {
    const atMax = SCENARIOS.map((def) => at(def, "max"));
    // Every scenario at once is more than a demo may hold; each largest selection that fits the
    // scenario cap, every scenario at its maximum, stays inside all the others.
    expect(atMax.length).toBeGreaterThan(MAX_SCENARIOS);
    expect(messageOf(pick(...atMax))).toBe(
      `A demo can include at most ${MAX_SCENARIOS} scenarios.`
    );
    // Leaving out a token holding leaves five stale offers without the tokens they trade, or
    // without any token at all, which is refused for that reason, and the sponsored fee is refused
    // beside anything but data entries and a forgotten signer, and never beside the exchange
    // deposit, which adds no entry and no cost, so it fits beside any other selection. The XLM cap is reached only with a
    // protocol scenario beside the costliest classic ones, and the contract-transaction cap only
    // with the bonded Phoenix position beside three allowances and another protocol scenario.
    let fitted = 0;
    let overXlm = 0;
    let overSoroban = 0;
    for (const kept of subsets(atMax.length, 0, MAX_SCENARIOS)) {
      const chosen = kept.map((i) => atMax[i]!);
      const result = validateSelection(pick(...chosen));
      if (result.ok) fitted++;
      else if (result.message.startsWith("This selection needs about")) {
        overXlm++;
        expect(
          chosen.some((c) =>
            ["soroswap-lp", "aquarius-lp", "blend-supply", "phoenix-lp"].includes(c.id)
          )
        ).toBe(true);
        expect(result.message).toEndWith(`a demo can use at most ${MAX_SESSION_XLM}.`);
      } else if (result.message.startsWith("This selection needs ")) {
        overSoroban++;
        expect(chosen.some((c) => c.id === "phoenix-lp")).toBe(true);
        expect(chosen.some((c) => c.id === "allowances")).toBe(true);
        expect(result.message).toEndWith(`the limit is ${MAX_SOROBAN_TRANSACTIONS}.`);
      } else if (result.message.startsWith("Sponsored fee ")) {
        expect(chosen.some((c) => c.id === "fee-bump")).toBe(true);
      } else if (result.message.startsWith("Exchange deposit ")) {
        expect(result.message).toBe("Exchange deposit cannot be combined with Sponsored fee.");
      } else expect(result.message).toStartWith("Stale DEX offers ");
    }
    expect({ fitted, overXlm, overSoroban }).toEqual({
      fitted: FITTED_AT_MAX,
      overXlm: OVER_XLM_AT_MAX,
      overSoroban: OVER_SOROBAN_AT_MAX,
    });
  });

  test("every selection the validator accepts is funded within the XLM cap", () => {
    for (let size = 1; size <= MAX_SCENARIOS; size++) {
      for (const kept of subsets(SCENARIOS.length, 0, size)) {
        for (const end of ["min", "max"] as const) {
          const result = validateSelection(pick(...kept.map((i) => at(SCENARIOS[i]!, end))));
          if (result.ok) expect(result.plan.cost.xlm).toBeLessThanOrEqual(MAX_SESSION_XLM);
        }
      }
    }
  });

  test("three allowances cost their approve and revoke fees and three contract transactions", () => {
    const result = validateSelection(pick({ id: "allowances", params: { spenders: 3 } }));
    if (!result.ok) throw new Error(result.message);
    const alone = validateSelection(pick({ id: "forgotten-signer", params: {} }));
    if (!alone.ok) throw new Error(alone.message);
    // About 0.2 XLM in fees per transaction: three approves and three revokes. An approval moves
    // no XLM, so nothing else is spent.
    expect(result.plan.cost.sorobanTransactions).toBe(3);
    expect(result.plan.cost.xlm).toBeCloseTo(2 * BASE_RESERVE_XLM + 6 * ALLOWANCE_FEE_ESTIMATE_XLM);
    // Beside every other protocol scenario at its largest, they still fit every cap.
    const everything = validateSelection(
      pick(
        { id: "allowances", params: { spenders: 3 } },
        { id: "soroswap-lp", params: {} },
        { id: "aquarius-lp", params: {} },
        { id: "blend-supply", params: { variant: 1 } }
      )
    );
    if (!everything.ok) throw new Error(everything.message);
    expect(everything.plan.cost.sorobanTransactions).toBe(MAX_SOROBAN_TRANSACTIONS);
    expect(everything.plan.cost.xlm).toBeLessThanOrEqual(MAX_SESSION_XLM);
  });

  for (const id of ["soroswap-lp", "aquarius-lp", "phoenix-lp"] as const) {
    test(`${id} fits beside any other scenario, and beside each classic preset`, () => {
      const pool = { id, params: {} };
      for (const def of SCENARIOS.filter((d) => d.id !== id)) {
        const result = validateSelection(pick(pool, at(def, "max")));
        // Only a scenario that needs another beside it may refuse the pair, and for that reason.
        if (!result.ok) {
          expect(def.requiresAnyOf.length).toBeGreaterThan(0);
          expect(result.message).toContain("needs one of these as well");
        }
      }
      for (const preset of [STANDARD_SELECTION, FULL_SELECTION]) {
        expect(validateSelection(pick(pool, ...preset.scenarios)).ok).toBe(true);
      }
    });
  }

  test("both pools fit beside the standard preset, and are refused beside the full one for XLM", () => {
    const pools = [
      { id: "soroswap-lp" as const, params: {} },
      { id: "aquarius-lp" as const, params: {} },
    ];
    const standard = validateSelection(pick(...pools, ...STANDARD_SELECTION.scenarios));
    if (!standard.ok) throw new Error(standard.message);
    expect(standard.plan.cost.xlm).toBeLessThanOrEqual(MAX_SESSION_XLM);
    expect(messageOf(pick(...pools, ...FULL_SELECTION.scenarios))).toStartWith(
      "This selection needs about"
    );
  });
});

describe("what a selection must satisfy", () => {
  test("at least one scenario", () => {
    expect(messageOf(pick())).toBe("Pick at least one scenario.");
  });

  test(`exactly ${MAX_SCENARIOS} scenarios pass the count cap and reach the other checks`, () => {
    const eight = Array.from({ length: MAX_SCENARIOS }, () => ({
      id: "data-entries" as const,
      params: {},
    }));
    expect(messageOf({ scenarios: eight })).toBe("Leftover data entries can only be picked once.");
  });

  test("each scenario once", () => {
    const twice = pick(
      { id: "data-entries", params: { count: 1 } },
      { id: "data-entries", params: { count: 2 } }
    );
    expect(messageOf(twice)).toBe("Leftover data entries can only be picked once.");
  });

  test("a parameter is a whole number inside its range, and only a known one", () => {
    const expected = "Leftover data entries: entries must be a whole number from 1 to 5.";
    for (const count of [0, 6, 1.5, Number.NaN]) {
      expect(messageOf(pick({ id: "data-entries", params: { count } }))).toBe(expected);
    }
    expect(messageOf(pick({ id: "data-entries", params: { count: 1, rows: 2 } }))).toBe(
      "Leftover data entries has no setting called that."
    );
  });

  test("a requirement is met by any one of its alternatives", () => {
    expect(messageOf(pick({ id: "stale-offers", params: { count: 1 } }))).toBe(
      "Stale DEX offers needs one of these as well: Demo token holding, Junk airdrops, Stablecoin swaps."
    );
    for (const provider of ["lwdemo-holding", "junk-airdrops", "stablecoin-swaps"] as const) {
      const ok = validateSelection(
        pick({ id: provider, params: {} }, { id: "stale-offers", params: { count: 1 } })
      );
      expect(ok.ok).toBe(true);
    }
  });

  test("an offer needs a trustline for the token it trades", () => {
    const lwdemoOnly = pick(
      { id: "lwdemo-holding", params: {} },
      { id: "stale-offers", params: { count: 2 } }
    );
    expect(messageOf(lwdemoOnly)).toBe(
      "Stale DEX offers can post at most 1 offer with the selected tokens: each offer trades a token the account holds."
    );
  });

  test("only the tokens a scenario's parameters open count toward offers", () => {
    const offers = (count: number) => ({ id: "stale-offers" as const, params: { count } });
    const oneOffer =
      "Stale DEX offers can post at most 1 offer with the selected tokens: each offer trades a token the account holds.";
    expect(messageOf(pick({ id: "junk-airdrops", params: { tokens: 1 } }, offers(2)))).toBe(
      oneOffer
    );
    expect(messageOf(pick({ id: "stablecoin-swaps", params: { tokens: 1 } }, offers(2)))).toBe(
      oneOffer
    );
    expect(messageOf(pick({ id: "junk-airdrops", params: { tokens: 2 } }, offers(3)))).toBe(
      "Stale DEX offers can post at most 2 offers with the selected tokens: each offer trades a token the account holds."
    );
  });

  test("conflicting scenarios are refused", () => {
    const [a, b] = SCENARIOS;
    const registry = [{ ...a!, conflicts: [b!.id] }, b!];
    expect(messageOf(pick({ id: a!.id, params: {} }, { id: b!.id, params: {} }), registry)).toBe(
      `${a!.label} cannot be combined with ${b!.label}.`
    );
  });

  test("a scenario this registry does not have is refused", () => {
    expect(
      messageOf(pick({ id: "data-entries", params: {} }), [synthetic("forgotten-signer", {})])
    ).toBe("The selection names a scenario this playground does not have.");
  });

  test("a scenario unavailable on this deployment is refused with its reason", () => {
    const result = validateSelection(pick({ id: "forgotten-signer", params: {} }), {
      unavailable: new Map([["forgotten-signer", "switched off for maintenance."]]),
    });
    expect(result).toEqual({
      ok: false,
      message: "Forgotten co-signer is not available here: switched off for maintenance.",
    });
  });

  test("two scenarios that would post the same step are refused", () => {
    const registry = [synthetic("forgotten-signer", {}), synthetic("data-entries", {})];
    const both = pick({ id: "forgotten-signer", params: {} }, { id: "data-entries", params: {} });
    expect(messageOf(both, registry)).toBe("This combination of scenarios is not supported.");
  });
});

describe("the resolved plan", () => {
  test("lists the selection in registry order with defaults filled in", () => {
    const { selection } = resolvePlan(
      pick({ id: "forgotten-signer", params: {} }, { id: "junk-airdrops", params: {} })
    );
    expect(selection).toEqual(
      pick({ id: "junk-airdrops", params: { tokens: 2 } }, { id: "forgotten-signer", params: {} })
    );
  });

  test("starts with the setup step, which creates exactly the planned issuers", () => {
    const plan = resolvePlan(
      pick({ id: "stablecoin-swaps", params: { tokens: 1 } }, { id: "data-entries", params: {} })
    );
    expect(plan.steps[0]?.action).toMatchObject({ kind: "setup", ephemeralAssets: ["USDC"] });
    expect(plan.ephemeralAssets).toEqual(["USDC"]);
  });

  test("adds the merge to the close, and the threshold reset only with a signer", () => {
    const types = (s: ScenarioSelection) => resolvePlan(s).expectation.operationTypes;
    expect(types(pick({ id: "data-entries", params: {} }))).toEqual(["accountMerge", "manageData"]);
    expect(types(pick({ id: "forgotten-signer", params: {} }))).toEqual([
      "accountMerge",
      "setOptions",
    ]);
  });

  test("sums the expectation and cost of its scenarios, listing each operation type once", () => {
    const plan = resolvePlan(
      pick(
        { id: "lwdemo-holding", params: {} },
        { id: "junk-airdrops", params: { tokens: 2 } },
        { id: "forgotten-signer", params: {} }
      )
    );
    expect(plan.expectation).toEqual({
      assets: ["LWDEMO", "AIRDROP1", "RUGPULL"],
      offers: 0,
      dataEntries: 0,
      signers: 1,
      closeOperations: 7,
      operationTypes: ["accountMerge", "payment", "changeTrust", "setOptions"],
      dispositions: [],
      arrivingAssets: [],
      sponsoredEntries: [],
      resolutions: [],
    });
    expect(plan.cost.classicTransactions).toBe(plan.steps.length);
    expect(plan.cost.subEntries).toBe(4);
  });

  test("a selection without trustlines skips the trustline removal in its estimate", () => {
    const seconds = (s: ScenarioSelection) => resolvePlan(s).cost.seconds;
    expect(seconds(pick({ id: "data-entries", params: { count: 1 } }))).toBe(13 + 13);
    expect(seconds(pick({ id: "lwdemo-holding", params: {} }))).toBe(13 + 8 + 18);
  });

  test("resolvePlan throws on a selection the validator refuses", () => {
    expect(() => resolvePlan(pick())).toThrow(
      "Invalid scenario selection: Pick at least one scenario."
    );
  });
});

describe("parseSelection", () => {
  test("reads a well-formed selection, with params optional", () => {
    expect(parseSelection({ scenarios: [{ id: "forgotten-signer" }] })).toEqual(
      pick({ id: "forgotten-signer", params: {} })
    );
    expect(parseSelection({ scenarios: [{ id: "data-entries", params: { count: 2 } }] })).toEqual(
      pick({ id: "data-entries", params: { count: 2 } })
    );
  });

  test("refuses anything else", () => {
    for (const bad of [
      null,
      "standard",
      [],
      {},
      { scenarios: "all" },
      { scenarios: [null] },
      { scenarios: [{ id: "drop-table" }] },
      { scenarios: [{ id: "toString" }] },
      { scenarios: [{ id: "data-entries", params: [] }] },
      { scenarios: [{ id: "data-entries", params: { count: "2" } }] },
    ]) {
      expect(parseSelection(bad)).toBeNull();
    }
  });

  test("a __proto__ parameter stays an own, unknown setting instead of touching the prototype", () => {
    const parsed = parseSelection(
      JSON.parse('{"scenarios":[{"id":"data-entries","params":{"__proto__":1}}]}')
    );
    expect(parsed).not.toBeNull();
    expect(messageOf(parsed!)).toBe("Leftover data entries has no setting called that.");
  });
});
