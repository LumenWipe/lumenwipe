import { describe, expect, test } from "bun:test";
import { MESS_EXECUTORS } from "@/lib/mess-builders";
import { PLAYGROUND_CLOSE_OPERATION_TYPES } from "@/lib/verify";
import {
  SCENARIOS,
  SCENE_NODE_KINDS,
  type ScenarioBuild,
  type ScenarioDefinition,
} from "@/lib/scenarios";

// Every scenario must be complete before it can ship: steps, a cost, a close expectation, an
// executor for each step it declares, a scene node for each entry it creates, and only operation
// types the playground verifier accepts.

const ALL_ASSETS = ["LWDEMO", "AIRDROP1", "RUGPULL", "USDC", "EURC", "LWCOIN", "LWGEM"] as const;

/** Every combination of a scenario's parameters. */
function paramCombos(def: ScenarioDefinition): Record<string, number>[] {
  let combos: Record<string, number>[] = [{}];
  for (const [name, spec] of Object.entries(def.params)) {
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (let v = spec.min; v <= spec.max; v++) next.push({ ...combo, [name]: v });
    }
    combos = next;
  }
  return combos;
}

function builds(def: ScenarioDefinition): ScenarioBuild[] {
  return paramCombos(def).map((params) => {
    const result = def.build(params, { heldAssets: ALL_ASSETS });
    if (!result.ok) throw new Error(`${def.id} ${JSON.stringify(params)}: ${result.message}`);
    return result.build;
  });
}

describe.each(SCENARIOS.map((def) => [def.id, def] as const))("%s", (_id, def) => {
  test("has a label, a description and sane parameter ranges", () => {
    expect(def.label.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
    for (const spec of Object.values(def.params)) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.min).toBeLessThanOrEqual(spec.default);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
    }
  });

  test("declares steps, each with an executor for its action", () => {
    for (const build of builds(def)) {
      expect(build.steps.length).toBeGreaterThan(0);
      for (const { step } of build.steps) {
        expect(step.label.length).toBeGreaterThan(0);
        expect(typeof MESS_EXECUTORS[step.action.kind]).toBe("function");
      }
    }
  });

  test("declares a cost", () => {
    for (const build of builds(def)) {
      const { cost } = build;
      expect(cost.classicTransactions + cost.sorobanTransactions).toBe(build.steps.length);
      expect(cost.seconds).toBeGreaterThan(0);
      expect(cost.xlm).toBeGreaterThan(0);
      expect(cost.batchSize).toBeGreaterThanOrEqual(1);
    }
  });

  test("declares a close expectation the playground verifier allows", () => {
    for (const build of builds(def)) {
      const { expectation } = build;
      expect(expectation.closeOperations).toBeGreaterThan(0);
      expect(expectation.operationTypes.length).toBeGreaterThan(0);
      for (const type of expectation.operationTypes) {
        expect(PLAYGROUND_CLOSE_OPERATION_TYPES).toContain(type);
      }
    }
  });

  test("declares one scene node for each entry it creates, each of a kind the scene draws", () => {
    for (const build of builds(def)) {
      const nodes = build.steps.flatMap(({ step }) => step.nodes);
      for (const node of nodes) expect(SCENE_NODE_KINDS).toContain(node.kind);
      expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
      const count = (kind: string): number => nodes.filter((n) => n.kind === kind).length;
      const { expectation } = build;
      expect(count("trustline")).toBe(expectation.assets.length);
      expect(count("offer")).toBe(expectation.offers);
      expect(count("data")).toBe(expectation.dataEntries);
      expect(count("signer")).toBe(expectation.signers);
      expect(build.cost.subEntries).toBe(nodes.length);
      const docked = new Set(nodes.map((n) => n.id));
      for (const { step } of build.steps) {
        for (const { nodeId } of step.balances) expect(docked.has(nodeId)).toBe(true);
      }
    }
  });
});

test("scenario ids and their step ids are unique across the registry", () => {
  expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  const owner = new Map<string, string>();
  for (const def of SCENARIOS) {
    for (const build of builds(def)) {
      for (const { step } of build.steps) {
        expect(owner.get(step.id) ?? def.id).toBe(def.id);
        owner.set(step.id, def.id);
      }
    }
  }
});

test("the merge and the threshold reset the resolver adds are allowed too", () => {
  expect(PLAYGROUND_CLOSE_OPERATION_TYPES).toContain("accountMerge");
  expect(PLAYGROUND_CLOSE_OPERATION_TYPES).toContain("setOptions");
});

test("requirements and conflicts name real scenarios, and held assets are real tokens", () => {
  const ids: readonly string[] = SCENARIOS.map((s) => s.id);
  for (const def of SCENARIOS) {
    for (const id of [...def.requiresAnyOf, ...def.conflicts]) expect(ids).toContain(id);
    for (const combo of paramCombos(def)) {
      const held = def.heldAssets(combo);
      expect(Array.isArray(held)).toBe(true);
      for (const code of held) expect(ALL_ASSETS).toContain(code);
    }
  }
});

test("scene nodes carry readable labels", () => {
  const nodes = SCENARIOS.flatMap((def) =>
    builds(def).flatMap((build) => build.steps.flatMap(({ step }) => step.nodes))
  );
  const label = (id: string) => nodes.find((n) => n.id === id)?.label;
  expect(label("offer:0")).toBe("Sell XLM → LWDEMO");
  expect(label("offer:1")).toBe("Sell AIRDROP1 → XLM");
  expect(label("signer:extra")).toBe("Forgotten co-signer");
  expect(label("tl:USDC")).toBe("USDC");
  expect(label("data:kyc_status")).toBe("kyc_status");
});
