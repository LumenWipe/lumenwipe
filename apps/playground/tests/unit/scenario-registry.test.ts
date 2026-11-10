import { describe, expect, test } from "bun:test";
import { MESS_EXECUTORS } from "@/lib/mess-builders";
import { PLAYGROUND_CLOSE_OPERATION_TYPES } from "@/lib/verify";
import {
  PURCHASE_OWNER,
  purchaseBuild,
  SCENARIOS,
  SCENE_NODE_KINDS,
  SUB_ENTRY_NODE_KINDS,
  withPinnedBalances,
  type ScenarioBuild,
  type ScenarioDefinition,
} from "@/lib/scenarios";

// Every scenario must be complete before it can ship: steps, a cost, a close expectation, an
// executor for each step it declares, a scene node for each entry it creates, and only operation
// types the playground verifier accepts. A scenario that spends a pinned asset is checked with the
// shared purchase the resolver adds for it (lib/scenarios/prerequisites.ts), as it runs alone.

const ALL_ASSETS = [
  "LWDEMO",
  "AIRDROP1",
  "RUGPULL",
  "USDC",
  "EURC",
  "LWCOIN",
  "LWGEM",
  "BONUS",
  "GIFT",
  "PERK",
] as const;

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

/** What a scenario builds on its own, without the shared purchase. */
function ownBuilds(def: ScenarioDefinition): ScenarioBuild[] {
  return paramCombos(def).map((params) => {
    const result = def.build(params, { heldAssets: ALL_ASSETS });
    if (!result.ok) throw new Error(`${def.id} ${JSON.stringify(params)}: ${result.message}`);
    return result.build;
  });
}

/** A scenario's build with the shared purchase its steps need, as the resolver adds it. */
function builds(def: ScenarioDefinition): ScenarioBuild[] {
  return ownBuilds(def).map((own) => {
    const shared = purchaseBuild(own.steps.map((o) => o.step));
    if (!shared) return own;
    const sum = (key: keyof ScenarioBuild["cost"]): number => own.cost[key] + shared.cost[key];
    const ordered = [...own.steps, ...shared.steps].sort((a, b) => a.order - b.order);
    const balanced = withPinnedBalances(ordered.map((o) => o.step));
    return {
      steps: ordered.map((o, i) => ({ order: o.order, step: balanced[i]! })),
      ephemeralAssets: own.ephemeralAssets,
      expectation: {
        ...own.expectation,
        closeOperations: own.expectation.closeOperations + shared.expectation.closeOperations,
        operationTypes: [
          ...new Set([...own.expectation.operationTypes, ...shared.expectation.operationTypes]),
        ],
      },
      cost: {
        xlm: sum("xlm"),
        classicTransactions: sum("classicTransactions"),
        sorobanTransactions: sum("sorobanTransactions"),
        seconds: sum("seconds"),
        batchSize: Math.max(own.cost.batchSize, shared.cost.batchSize),
        subEntries: sum("subEntries"),
      },
    };
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
      // A position's exits are transactions of their own, so a scenario whose only entry is a
      // position (Blend's, which buys nothing) adds no operation to the merge. An allowance's
      // revoke is sent before the close, so allowances add nothing to the close at all, and the
      // drain only changes who pays the close's fee.
      const kinds = build.steps.flatMap(({ step }) => step.nodes).map((n) => n.kind);
      const allowances = kinds.filter((k) => k === "allowance").length;
      if (build.steps.every(({ step }) => step.action.kind === "drain_to_fee_floor")) {
        expect(kinds).toEqual([]);
        expect(expectation.closeOperations).toBe(0);
        expect(expectation.operationTypes).toEqual([]);
        continue;
      }
      if (allowances > 0) {
        expect(kinds.every((k) => k === "allowance")).toBe(true);
        expect(expectation.closeOperations).toBe(0);
        expect(expectation.operationTypes).toEqual([]);
        continue;
      }
      const positions = kinds.filter((k) => k === "position");
      if (positions.length === 0 || build.steps.some(({ step }) => step.spendsPinned)) {
        expect(expectation.closeOperations).toBeGreaterThan(0);
      } else {
        expect(expectation.closeOperations).toBe(0);
      }
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
      const actions = (kind: string): number =>
        build.steps.filter(({ step }) => step.action.kind === kind).length;
      // A pinned asset's trustline is the verifier's to add (lib/verify.ts), from its own step.
      expect(count("trustline")).toBe(expectation.assets.length + actions("pinned_trust"));
      expect(count("offer")).toBe(expectation.offers);
      expect(count("data")).toBe(expectation.dataEntries);
      expect(count("signer")).toBe(expectation.signers);
      // One position per deposit, and its exit is a close transaction of its own. Phoenix's swap
      // and bond only lead to or change the position its deposit opens.
      expect(count("position")).toBe(
        actions("soroswap_deposit") +
          actions("aquarius_deposit") +
          actions("blend_submit") +
          actions("phoenix_provide")
      );
      if (count("position") > 0) expect(expectation.operationTypes).toContain("invokeHostFunction");
      // One allowance per approve, each a contract call of its own.
      expect(count("allowance")).toBe(actions("approve_allowance"));
      // Only the account's own entries hold a reserve; a position lives in a contract.
      const subEntries = nodes.filter((n) => SUB_ENTRY_NODE_KINDS.includes(n.kind)).length;
      expect(build.cost.subEntries).toBe(subEntries);
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
  const claim = (stepId: string, by: string): void => {
    expect(owner.get(stepId) ?? by).toBe(by);
    owner.set(stepId, by);
  };
  // The shared purchase's steps belong to the resolver: no scenario declares one of them itself.
  const spending = SCENARIOS.flatMap(ownBuilds).flatMap((b) => b.steps.map((o) => o.step));
  for (const { step } of purchaseBuild(spending)?.steps ?? []) claim(step.id, PURCHASE_OWNER);
  expect(owner.size).toBeGreaterThan(0);
  for (const def of SCENARIOS) {
    for (const build of ownBuilds(def)) {
      for (const { step } of build.steps) claim(step.id, def.id);
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
