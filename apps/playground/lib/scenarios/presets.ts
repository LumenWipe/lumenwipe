import { SCENARIOS } from "./definitions";
import { validateSelection, type ValidateOptions } from "./resolve";
import type {
  FeatureSetId,
  ScenarioChoice,
  ScenarioDefinition,
  ScenarioId,
  ScenarioSelection,
} from "./types";

export interface FeatureSet {
  id: FeatureSetId;
  label: string;
}

export const FEATURE_SETS: readonly FeatureSet[] = [
  { id: "classic", label: "Classic account teardown" },
  { id: "protocol", label: "Protocol exits" },
  { id: "api", label: "API, batch and exchange" },
];

export const NO_SCENARIOS_REASON = "No scenarios in this set run on this deployment yet.";

export const LIGHT_SELECTION: ScenarioSelection = {
  scenarios: [{ id: "lwdemo-holding", params: {} }],
};

/** The classic preset, and the default selection. */
export const STANDARD_SELECTION: ScenarioSelection = {
  scenarios: [
    { id: "lwdemo-holding", params: {} },
    { id: "junk-airdrops", params: { tokens: 2 } },
    { id: "data-entries", params: { count: 3 } },
    { id: "stale-offers", params: { count: 3 } },
    { id: "forgotten-signer", params: {} },
  ],
};

export const FULL_SELECTION: ScenarioSelection = {
  scenarios: [
    { id: "lwdemo-holding", params: {} },
    { id: "junk-airdrops", params: { tokens: 2 } },
    { id: "stablecoin-swaps", params: { tokens: 2 } },
    { id: "data-entries", params: { count: 3 } },
    { id: "stale-offers", params: { count: 5 } },
    { id: "forgotten-signer", params: {} },
  ],
};

/**
 * A feature set's preset: the classic one is the standard recipe, any other is every available
 * scenario of its set at default settings, with the first available scenario each one requires.
 * Null when nothing in the set can run here.
 */
export function presetSelection(
  featureSet: FeatureSetId,
  options: ValidateOptions = {}
): ScenarioSelection | null {
  const unavailable = options.unavailable ?? new Map<ScenarioId, string>();
  const base =
    featureSet === "classic"
      ? STANDARD_SELECTION.scenarios
      : withRequirements(
          SCENARIOS.filter((s) => s.featureSet === featureSet && !unavailable.has(s.id)),
          unavailable
        );
  const candidate = { scenarios: base.filter((c) => !unavailable.has(c.id)) };
  if (candidate.scenarios.length === 0) return null;
  const fitted = fitSelection(candidate, options);
  return validateSelection(fitted, options).ok ? fitted : null;
}

/** The scenarios at default settings, and the first available provider of each unmet requirement. */
function withRequirements(
  defs: readonly ScenarioDefinition[],
  unavailable: ReadonlyMap<ScenarioId, string>
): ScenarioChoice[] {
  const ids = new Set<ScenarioId>(defs.map((d) => d.id));
  for (const def of defs) {
    if (def.requiresAnyOf.length === 0 || def.requiresAnyOf.some((r) => ids.has(r))) continue;
    const provider = def.requiresAnyOf.find((r) => !unavailable.has(r));
    if (provider) ids.add(provider);
  }
  return [...ids].map((id) => ({ id, params: {} }));
}

const definitionOf = (id: ScenarioId): ScenarioDefinition | undefined =>
  SCENARIOS.find((s) => s.id === id);

function defaults(id: ScenarioId): Record<string, number> {
  const params = definitionOf(id)?.params ?? {};
  return Object.fromEntries(Object.entries(params).map(([n, p]) => [n, p.default]));
}

/** Lowers the last parameter above its minimum, scanning from the last scenario; false if none. */
function lowerOne(scenarios: ScenarioChoice[]): boolean {
  for (const choice of [...scenarios].reverse()) {
    const params = Object.entries(definitionOf(choice.id)?.params ?? {}).reverse();
    for (const [name, spec] of params) {
      const value = choice.params[name] ?? spec.default;
      if (value > spec.min) {
        choice.params[name] = value - 1;
        return true;
      }
    }
  }
  return false;
}

/**
 * Brings a selection inside the registry's rules and caps by the same steps every time: lower the
 * last parameter still above its minimum, else drop the last scenario, until the validator accepts
 * it or one scenario is left.
 */
export function fitSelection(
  selection: ScenarioSelection,
  options: ValidateOptions = {}
): ScenarioSelection {
  const order = (id: ScenarioId): number => SCENARIOS.findIndex((s) => s.id === id);
  let scenarios = [...selection.scenarios]
    .sort((a, b) => order(a.id) - order(b.id))
    .map((c) => ({ id: c.id, params: { ...defaults(c.id), ...c.params } }));
  for (;;) {
    const result = validateSelection({ scenarios }, options);
    if (result.ok) return result.plan.selection;
    if (lowerOne(scenarios)) continue;
    if (scenarios.length <= 1) return { scenarios };
    scenarios = scenarios.slice(0, -1);
  }
}

/** Turns a scenario on or off, pulling in what it requires and dropping what then lacks a requirement. */
export function toggleScenario(
  selection: ScenarioSelection,
  id: ScenarioId,
  on: boolean,
  options: ValidateOptions = {}
): ScenarioSelection {
  const unavailable = options.unavailable ?? new Map<ScenarioId, string>();
  let scenarios = selection.scenarios.filter((c) => c.id !== id);
  if (on) scenarios.push({ id, params: defaults(id) });
  for (let changed = true; changed;) {
    changed = false;
    const ids = new Set(scenarios.map((c) => c.id));
    for (const def of SCENARIOS) {
      if (!ids.has(def.id) || def.requiresAnyOf.length === 0) continue;
      if (def.requiresAnyOf.some((r) => ids.has(r))) continue;
      const provider = on && def.id === id && def.requiresAnyOf.find((r) => !unavailable.has(r));
      scenarios = provider
        ? [...scenarios, { id: provider, params: defaults(provider) }]
        : scenarios.filter((c) => c.id !== def.id);
      changed = true;
      break;
    }
  }
  return scenarios.length === 0 ? { scenarios } : fitSelection({ scenarios }, options);
}

/** Sets one parameter, then fits the selection, so a value the selection cannot hold is lowered. */
export function setScenarioParam(
  selection: ScenarioSelection,
  id: ScenarioId,
  name: string,
  value: number,
  options: ValidateOptions = {}
): ScenarioSelection {
  const scenarios = selection.scenarios.map((c) =>
    c.id === id ? { id, params: { ...c.params, [name]: value } } : c
  );
  return fitSelection({ scenarios }, options);
}
