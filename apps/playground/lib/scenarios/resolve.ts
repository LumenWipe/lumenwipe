import {
  MAX_ESTIMATED_SECONDS,
  MAX_SCENARIOS,
  MAX_SESSION_XLM,
  MAX_SOROBAN_TRANSACTIONS,
  MAX_SUB_ENTRIES,
} from "./caps";
import {
  BASE_RESERVE_XLM,
  DEMO_HEADROOM_XLM,
  EPHEMERAL_ISSUER_FUNDING_XLM,
  type AssetCode,
} from "./catalog";
import { CLOSE_GROUP_SECONDS, MESS_STEP_SECONDS, ORDER, SCENARIOS } from "./definitions";
import { purchaseBuild, withPinnedBalances } from "./prerequisites";
import type {
  MessStepDef,
  OrderedStep,
  ScenarioBuild,
  ScenarioChoice,
  ScenarioCost,
  ScenarioDefinition,
  ScenarioExpectation,
  ScenarioId,
  ScenarioSelection,
} from "./types";

export interface ResolvedPlan {
  /** The selection in registry order with every parameter filled in. */
  selection: ScenarioSelection;
  steps: MessStepDef[];
  ephemeralAssets: AssetCode[];
  expectation: ScenarioExpectation;
  cost: ScenarioCost;
}

export type ValidationResult = { ok: true; plan: ResolvedPlan } | { ok: false; message: string };

export interface ValidateOptions {
  /** Scenarios this deployment cannot run, with the reason shown to the user. */
  unavailable?: ReadonlyMap<ScenarioId, string>;
  registry?: readonly ScenarioDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return SCENARIOS.some((s) => s.id === value);
}

function parseChoice(value: unknown): ScenarioChoice | null {
  if (!isRecord(value) || !isScenarioId(value.id)) return null;
  const rawParams = value.params ?? {};
  if (!isRecord(rawParams)) return null;
  const entries: [string, number][] = [];
  for (const [name, param] of Object.entries(rawParams)) {
    if (typeof param !== "number") return null;
    entries.push([name, param]);
  }
  return { id: value.id, params: Object.fromEntries(entries) };
}

/** Reads a selection from untrusted input; null for anything not shaped like one. */
export function parseSelection(value: unknown): ScenarioSelection | null {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) return null;
  const scenarios: ScenarioChoice[] = [];
  for (const raw of value.scenarios) {
    const choice = parseChoice(raw);
    if (!choice) return null;
    scenarios.push(choice);
  }
  return { scenarios };
}

/** Reads the unavailable scenarios `GET /api/scenarios` returns; anything malformed is skipped. */
export function parseUnavailable(value: unknown): Map<ScenarioId, string> {
  const unavailable = new Map<ScenarioId, string>();
  if (!isRecord(value) || !Array.isArray(value.unavailable)) return unavailable;
  for (const entry of value.unavailable) {
    if (isRecord(entry) && isScenarioId(entry.id) && typeof entry.reason === "string") {
      unavailable.set(entry.id, entry.reason);
    }
  }
  return unavailable;
}

const fail = (message: string): ValidationResult => ({ ok: false, message });

/** What the market maker funds the demo with: the selection's cost plus fixed headroom. */
export function demoFundingXlm(cost: ScenarioCost): string {
  return (cost.xlm + DEMO_HEADROOM_XLM).toFixed(7);
}

function setupStep(ephemeralAssets: AssetCode[], fundingXlm: string): OrderedStep {
  return {
    order: ORDER.setup,
    step: {
      id: "SETUP",
      label: "Fund demo account & spawn rogue issuers",
      nodes: [],
      balances: [],
      action: {
        kind: "setup",
        ephemeralAssets,
        issuerFundingXlm: EPHEMERAL_ISSUER_FUNDING_XLM,
        fundingXlm,
      },
    },
  };
}

function capMessage(cost: ScenarioCost): string | null {
  if (cost.subEntries > MAX_SUB_ENTRIES) {
    return `This selection adds ${cost.subEntries} entries to the account; the limit is ${MAX_SUB_ENTRIES}.`;
  }
  if (cost.xlm > MAX_SESSION_XLM) {
    return `This selection needs about ${cost.xlm} test XLM; a demo can use at most ${MAX_SESSION_XLM}.`;
  }
  if (cost.sorobanTransactions > MAX_SOROBAN_TRANSACTIONS) {
    return `This selection needs ${cost.sorobanTransactions} contract transactions; the limit is ${MAX_SOROBAN_TRANSACTIONS}.`;
  }
  if (cost.seconds > MAX_ESTIMATED_SECONDS) {
    return `This selection would take about ${Math.ceil(cost.seconds / 60)} minutes; a demo is limited to ${MAX_ESTIMATED_SECONDS / 60}.`;
  }
  return null;
}

/**
 * Checks a selection against the registry, this deployment's availability and the safety caps,
 * and resolves it into the one plan the UI shows, the executor posts and the verifier expects.
 */
export function validateSelection(
  selection: ScenarioSelection,
  { unavailable = new Map(), registry = SCENARIOS }: ValidateOptions = {}
): ValidationResult {
  const { scenarios } = selection;
  if (scenarios.length === 0) return fail("Pick at least one scenario.");
  if (scenarios.length > MAX_SCENARIOS) {
    return fail(`A demo can include at most ${MAX_SCENARIOS} scenarios.`);
  }

  const picked: { def: ScenarioDefinition; params: Record<string, number> }[] = [];
  for (const def of registry) {
    const matches = scenarios.filter((c) => c.id === def.id);
    if (matches.length > 1) return fail(`${def.label} can only be picked once.`);
    const choice = matches[0];
    if (!choice) continue;
    const reason = unavailable.get(def.id);
    if (reason !== undefined) return fail(`${def.label} is not available here: ${reason}`);
    const params: Record<string, number> = {};
    const given = Object.keys(choice.params);
    const known = Object.keys(def.params);
    for (const name of given) {
      if (!known.includes(name)) {
        return fail(`${def.label} has no setting called that.`);
      }
    }
    for (const [name, spec] of Object.entries(def.params)) {
      const value = choice.params[name] ?? spec.default;
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        return fail(
          `${def.label}: ${spec.label.toLowerCase()} must be a whole number from ${spec.min} to ${spec.max}.`
        );
      }
      params[name] = value;
    }
    picked.push({ def, params });
  }
  if (picked.length !== scenarios.length) {
    return fail("The selection names a scenario this playground does not have.");
  }

  const ids = new Set(picked.map((p) => p.def.id));
  for (const { def } of picked) {
    if (def.requiresAnyOf.length > 0 && !def.requiresAnyOf.some((id) => ids.has(id))) {
      const names = registry.filter((d) => def.requiresAnyOf.includes(d.id)).map((d) => d.label);
      return fail(`${def.label} needs one of these as well: ${names.join(", ")}.`);
    }
    const clash = registry.find((d) => def.conflicts.includes(d.id) && ids.has(d.id));
    if (clash) return fail(`${def.label} cannot be combined with ${clash.label}.`);
  }

  const heldAssets = picked.flatMap(({ def, params }) => def.heldAssets(params));
  const ordered: OrderedStep[] = [];
  const ephemeralAssets: AssetCode[] = [];
  const expectation: ScenarioExpectation = {
    assets: [],
    offers: 0,
    dataEntries: 0,
    signers: 0,
    closeOperations: 0,
    operationTypes: ["accountMerge"],
    dispositions: [],
    arrivingAssets: [],
    sponsoredEntries: [],
    resolutions: [],
  };
  const cost: ScenarioCost = {
    xlm: 2 * BASE_RESERVE_XLM,
    classicTransactions: 1,
    sorobanTransactions: 0,
    seconds: MESS_STEP_SECONDS + CLOSE_GROUP_SECONDS,
    subEntries: 0,
  };
  const absorb = (build: ScenarioBuild): void => {
    ordered.push(...build.steps);
    ephemeralAssets.push(...build.ephemeralAssets);
    expectation.assets.push(...build.expectation.assets);
    expectation.offers += build.expectation.offers;
    expectation.dataEntries += build.expectation.dataEntries;
    expectation.signers += build.expectation.signers;
    expectation.closeOperations += build.expectation.closeOperations;
    expectation.dispositions.push(...build.expectation.dispositions);
    expectation.arrivingAssets.push(...build.expectation.arrivingAssets);
    expectation.sponsoredEntries.push(...build.expectation.sponsoredEntries);
    expectation.resolutions.push(...build.expectation.resolutions);
    for (const type of build.expectation.operationTypes) {
      if (!expectation.operationTypes.includes(type)) expectation.operationTypes.push(type);
    }
    cost.xlm += build.cost.xlm;
    cost.classicTransactions += build.cost.classicTransactions;
    cost.sorobanTransactions += build.cost.sorobanTransactions;
    cost.seconds += build.cost.seconds;
    cost.subEntries += build.cost.subEntries;
  };
  for (const { def, params } of picked) {
    const result = def.build(params, { heldAssets });
    if (!result.ok) return fail(result.message);
    absorb(result.build);
  }
  // What the scenarios spend of a pinned asset is bought once, for all of them together.
  const purchases = purchaseBuild(ordered.map((o) => o.step));
  if (purchases) absorb(purchases);
  // Removing the emptied trustlines is one more close step once there is any.
  if (expectation.assets.length > 0) cost.seconds += CLOSE_GROUP_SECONDS;

  const capped = capMessage(cost);
  if (capped) return fail(capped);

  ordered.push(setupStep(ephemeralAssets, demoFundingXlm(cost)));
  const steps = withPinnedBalances(ordered.sort((a, b) => a.order - b.order).map((o) => o.step));
  if (new Set(steps.map((s) => s.id)).size !== steps.length) {
    return fail("This combination of scenarios is not supported.");
  }

  return {
    ok: true,
    plan: {
      selection: { scenarios: picked.map(({ def, params }) => ({ id: def.id, params })) },
      steps,
      ephemeralAssets,
      expectation,
      cost,
    },
  };
}

/** Resolves a selection the server already validated (a stored session's, or a named preset). */
export function resolvePlan(selection: ScenarioSelection): ResolvedPlan {
  const result = validateSelection(selection);
  if (!result.ok) throw new Error(`Invalid scenario selection: ${result.message}`);
  return result.plan;
}
