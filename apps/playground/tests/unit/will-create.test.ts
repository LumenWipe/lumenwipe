import { describe, expect, test } from "bun:test";
import { lockedReserveXlm } from "@/lib/account-summary";
import {
  FEATURE_SETS,
  LIGHT_SELECTION,
  SCENARIOS,
  STANDARD_SELECTION,
  generateRandomSelection,
  messProgress,
  presetSelection,
  resolvePlan,
  willCreate,
  type MessStepDef,
  type ScenarioSelection,
} from "@/lib/scenarios";

// The pre-run list and the progress line read only the resolved plan, so they cannot describe a
// run other than the one the executor performs.

function plans(): MessStepDef[][] {
  const selections: ScenarioSelection[] = [STANDARD_SELECTION, LIGHT_SELECTION];
  for (const set of FEATURE_SETS) {
    const preset = presetSelection(set.id);
    if (preset) selections.push(preset);
  }
  for (let seed = 1; seed <= 40; seed++) {
    const random = generateRandomSelection(seed);
    if (random) selections.push(random);
  }
  return selections.map((s) => resolvePlan(s).steps);
}

const countIn = (lines: string[], noun: RegExp): number => {
  const line = lines.find((l) => noun.test(l));
  return line ? Number(line.split(" ")[0]) : 0;
};

describe("the will-create list", () => {
  test("counts exactly the entries the plan docks, by kind", () => {
    for (const steps of plans()) {
      const lines = willCreate(steps);
      const nodes = steps.flatMap((s) => s.nodes);
      const of = (kind: string) => nodes.filter((n) => n.kind === kind).length;
      expect(countIn(lines, /^\d+ trustlines?$/)).toBe(of("trustline"));
      expect(countIn(lines, /^\d+ open DEX offers?$/)).toBe(of("offer"));
      expect(countIn(lines, /^\d+ data entr(y|ies)$/)).toBe(of("data"));
      expect(countIn(lines, /^\d+ protocol positions?$/)).toBe(of("position"));
      expect(countIn(lines, /^\d+ token allowances?$/)).toBe(of("allowance"));
      const loose = steps
        .filter((s) => s.action.kind !== "multisig")
        .flatMap((s) => s.nodes)
        .filter((n) => n.kind === "signer").length;
      expect(countIn(lines, /^\d+ extra signers?$/)).toBe(loose);
    }
  });

  test("names the funding, and throwaway issuers only when the plan has some", () => {
    const light = willCreate(resolvePlan(LIGHT_SELECTION).steps);
    expect(light[0]).toMatch(/^A demo account funded with [\d.]+ test XLM$/);
    expect(light.some((l) => l.includes("issuer"))).toBe(false);
    const standard = resolvePlan(STANDARD_SELECTION);
    expect(willCreate(standard.steps)).toContain(
      `${standard.ephemeralAssets.length} throwaway asset issuers`
    );
  });

  test("a multisig selection says what its signer set is", () => {
    const steps = resolvePlan({
      scenarios: [{ id: "multisig", params: { variant: 0 } }],
    }).steps;
    expect(willCreate(steps)).toContain("a 2-of-3 signer set");
  });
});

describe("the progress line", () => {
  test("every step a scenario planned names that scenario; only setup and shared steps do not", () => {
    for (const steps of plans()) {
      for (const step of steps) {
        const shared = ["setup", "pinned_trust", "pinned_buy"].includes(step.action.kind);
        if (shared) expect(step.scenario).toBeUndefined();
        else expect(SCENARIOS.some((d) => d.id === step.scenario)).toBe(true);
      }
    }
  });

  test("counts the step within its own scenario and within the whole run", () => {
    const steps = resolvePlan(STANDARD_SELECTION).steps;
    expect(messProgress(steps, 0)).toEqual({
      label: steps[0]!.label,
      detail: `Setup, step 1 of ${steps.length}`,
    });
    for (let i = 1; i < steps.length; i++) {
      const step = steps[i]!;
      if (!step.scenario) continue;
      const own = steps.filter((s) => s.scenario === step.scenario);
      const name = SCENARIOS.find((d) => d.id === step.scenario)!.label;
      expect(messProgress(steps, i).detail).toBe(
        `${name}, ${own.indexOf(step) + 1} of ${own.length}; step ${i + 1} of ${steps.length}`
      );
    }
    const airdrops = steps.filter((s) => s.scenario === "junk-airdrops");
    expect(airdrops.length).toBeGreaterThan(1);
  });
});

describe("the locked reserve", () => {
  test("two base reserves, one per sub-entry and per sponsoring entry, less what others pay", () => {
    expect(lockedReserveXlm({ numSubEntries: 0, numSponsoring: 0 })).toBe(1);
    expect(lockedReserveXlm({ numSubEntries: 3, numSponsoring: 0 })).toBe(2.5);
    expect(lockedReserveXlm({ numSubEntries: 3, numSponsoring: 2, numSponsored: 1 })).toBe(3);
  });
});
