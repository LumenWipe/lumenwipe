import { describe, expect, test } from "bun:test";
import {
  FEATURE_SETS,
  STANDARD_SELECTION,
  fitSelection,
  presetSelection,
  resolvePlan,
  setScenarioParam,
  toggleScenario,
  validateSelection,
  type ScenarioSelection,
} from "@/lib/scenarios";

const ids = (s: ScenarioSelection): string[] => s.scenarios.map((c) => c.id);
const off = (...disabled: string[]) => ({
  unavailable: new Map(disabled.map((id) => [id as never, "Switched off."])),
});

describe("presets", () => {
  test("the classic preset is the standard recipe", () => {
    expect(presetSelection("classic")).toEqual(resolvePlan(STANDARD_SELECTION).selection);
  });

  test("a feature set with no scenario here has no preset", () => {
    expect(presetSelection("protocol")).toBeNull();
    expect(presetSelection("api")).toBeNull();
  });

  test("a preset leaves out what this deployment switched off", () => {
    const classic = presetSelection("classic", off("data-entries"))!;
    expect(ids(classic)).toEqual([
      "lwdemo-holding",
      "junk-airdrops",
      "stale-offers",
      "forgotten-signer",
    ]);
  });

  test("feature set names are what the UI shows", () => {
    expect(FEATURE_SETS.map((f) => f.label)).toEqual([
      "Classic account teardown",
      "Protocol exits",
      "API, batch and exchange",
    ]);
  });
});

describe("toggling", () => {
  const signerOnly: ScenarioSelection = { scenarios: [{ id: "forgotten-signer", params: {} }] };

  test("turning a scenario on pulls in what it requires", () => {
    const next = toggleScenario(signerOnly, "stale-offers", true);
    expect(ids(next)).toEqual(["lwdemo-holding", "stale-offers", "forgotten-signer"]);
    expect(validateSelection(next).ok).toBe(true);
  });

  test("the pulled requirement skips a provider switched off here", () => {
    const next = toggleScenario(signerOnly, "stale-offers", true, off("lwdemo-holding"));
    expect(ids(next)).toEqual(["junk-airdrops", "stale-offers", "forgotten-signer"]);
  });

  test("turning off the last provider drops what required it", () => {
    const withOffers = toggleScenario(signerOnly, "stale-offers", true);
    expect(ids(toggleScenario(withOffers, "lwdemo-holding", false))).toEqual(["forgotten-signer"]);
  });

  test("turning off a provider that is not the last keeps its dependants", () => {
    const both = toggleScenario(
      toggleScenario(signerOnly, "stale-offers", true),
      "junk-airdrops",
      true
    );
    expect(ids(toggleScenario(both, "lwdemo-holding", false))).toEqual([
      "junk-airdrops",
      "stale-offers",
      "forgotten-signer",
    ]);
  });

  test("turning off the only scenario leaves an empty selection the validator refuses", () => {
    const empty = toggleScenario(signerOnly, "forgotten-signer", false);
    expect(empty).toEqual({ scenarios: [] });
    expect(validateSelection(empty)).toEqual({ ok: false, message: "Pick at least one scenario." });
  });

  test("turning a token off lowers the offers to what the remaining tokens can trade", () => {
    const full = resolvePlan({
      scenarios: [
        { id: "lwdemo-holding", params: {} },
        { id: "junk-airdrops", params: { tokens: 2 } },
        { id: "stale-offers", params: { count: 3 } },
      ],
    }).selection;
    const next = toggleScenario(full, "junk-airdrops", false);
    expect(next.scenarios).toEqual([
      { id: "lwdemo-holding", params: {} },
      { id: "stale-offers", params: { count: 1 } },
    ]);
  });
});

describe("parameters", () => {
  const base: ScenarioSelection = {
    scenarios: [
      { id: "junk-airdrops", params: { tokens: 1 } },
      { id: "stale-offers", params: { count: 1 } },
    ],
  };

  test("a value the selection can hold is set as given", () => {
    const next = setScenarioParam(base, "junk-airdrops", "tokens", 2);
    expect(next.scenarios[0]).toEqual({ id: "junk-airdrops", params: { tokens: 2 } });
  });

  test("a value the selection cannot hold is lowered until it fits", () => {
    const next = setScenarioParam(base, "stale-offers", "count", 4);
    expect(next.scenarios[1]).toEqual({ id: "stale-offers", params: { count: 1 } });
  });
});

describe("fitSelection", () => {
  test("a valid selection comes back unchanged apart from order and defaults", () => {
    expect(
      fitSelection({
        scenarios: [
          { id: "forgotten-signer", params: {} },
          { id: "data-entries", params: {} },
        ],
      })
    ).toEqual({
      scenarios: [
        { id: "data-entries", params: { count: 3 } },
        { id: "forgotten-signer", params: {} },
      ],
    });
  });

  test("lowers the last parameter above its minimum first", () => {
    const fitted = fitSelection(
      {
        scenarios: [
          { id: "junk-airdrops", params: { tokens: 1 } },
          { id: "data-entries", params: { count: 5 } },
          { id: "stale-offers", params: { count: 5 } },
        ],
      },
      off()
    );
    expect(fitted.scenarios.map((c) => c.params)).toEqual([
      { tokens: 1 },
      { count: 5 },
      { count: 1 },
    ]);
  });

  test("drops the last scenario when no parameter can be lowered", () => {
    const fitted = fitSelection({
      scenarios: [
        { id: "forgotten-signer", params: {} },
        { id: "stale-offers", params: { count: 1 } },
      ],
    });
    // Registry order puts the signer last, so it goes first; one scenario is never dropped.
    expect(ids(fitted)).toEqual(["stale-offers"]);
  });

  test("keeps a single scenario even when the validator refuses it", () => {
    const one = { scenarios: [{ id: "stale-offers" as const, params: { count: 1 } }] };
    expect(fitSelection(one)).toEqual(one);
  });
});
