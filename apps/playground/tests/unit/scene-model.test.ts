import { describe, expect, test } from "bun:test";
import {
  GUIDE_RINGS,
  KIND_META,
  KIND_ORDER,
  SCENE_HALF,
  buildSceneNode,
  legendKinds,
  nextFocusIndex,
  nodeAccessibleName,
  orbitAngle,
  planNodes,
  sceneOrder,
  sceneStill,
} from "@/lib/scene-model";
import { SCENE_NODE_KINDS, resolvePlan, BLOCKED_MEMBER_SELECTION } from "@/lib/scenarios";
import type { SceneNode } from "@/store/playground";

const node = (id: string, kind: string, label = id): SceneNode => ({
  ...buildSceneNode({ id, kind, label }, 0),
  status: "docked",
});

describe("the kinds the scene draws", () => {
  test("every planned kind and the generic one has a name, a meaning and a ring", () => {
    expect([...KIND_ORDER].sort()).toEqual([...SCENE_NODE_KINDS, "generic" as const].sort());
    for (const kind of KIND_ORDER) {
      expect(KIND_META[kind].name.length).toBeGreaterThan(0);
      expect(KIND_META[kind].meaning.length).toBeGreaterThan(0);
    }
  });

  test("rings run outward in kind order, the outer one inside 240 of 280", () => {
    const radii = KIND_ORDER.map((k) => KIND_META[k].radius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(Math.max(...GUIDE_RINGS)).toBeLessThanOrEqual(240 / SCENE_HALF);
    expect(new Set(GUIDE_RINGS).size).toBe(GUIDE_RINGS.length);
  });
});

describe("one node in words", () => {
  test("names its kind, label, balance and where it stands", () => {
    expect(nodeAccessibleName(node("tl:BONUS", "trustline", "BONUS"))).toBe(
      "Trustline BONUS, on testnet"
    );
    expect(
      nodeAccessibleName({ ...node("tl:GIFT", "trustline", "GIFT"), balance: "1234.5678" })
    ).toBe("Trustline GIFT, balance 1,234.57, on testnet");
    expect(
      nodeAccessibleName({ ...node("cb:claim:0", "claimable", "BONUS"), status: "destroyed" })
    ).toBe("Claimable balance BONUS, removed");
    expect(nodeAccessibleName({ ...node("tl:X", "trustline", "X"), status: "converting" })).toBe(
      "Trustline X, being converted to XLM"
    );
  });
});

test("the legend lists each kind in the scene once, in ring order", () => {
  const nodes = [
    node("cb:claim:0", "claimable"),
    node("tl:A", "trustline"),
    node("signer:extra", "signer"),
    node("tl:B", "trustline"),
    { ...node("data:x", "data"), status: "destroyed" as const },
  ];
  expect(legendKinds(nodes)).toEqual(["signer", "trustline", "data", "claimable"]);
  expect(legendKinds([])).toEqual([]);
});

test("the scene's order is ring order, then creation order", () => {
  const nodes = [
    node("cb:claim:0", "claimable"),
    node("tl:A", "trustline"),
    node("tl:B", "trustline"),
  ];
  expect(sceneOrder(nodes).map((n) => n.id)).toEqual(["tl:A", "tl:B", "cb:claim:0"]);
});

test("the orbit stands still under reduced motion, a pause, or a pointer or focus on it", () => {
  expect(sceneStill(false, false, false)).toBe(false);
  expect(sceneStill(true, false, false)).toBe(true);
  expect(sceneStill(false, true, false)).toBe(true);
  expect(sceneStill(false, false, true)).toBe(true);
});

test("a node's angle starts at its phase and turns once per orbit", () => {
  expect(orbitAngle(90, 20, 0)).toBeCloseTo(Math.PI / 2);
  expect(orbitAngle(90, 20, 20_000)).toBeCloseTo(Math.PI / 2 + 2 * Math.PI);
});

test("the arrow keys move through the nodes and wrap, Home and End jump to the ends", () => {
  expect(nextFocusIndex("ArrowRight", 0, 3)).toBe(1);
  expect(nextFocusIndex("ArrowDown", 2, 3)).toBe(0);
  expect(nextFocusIndex("ArrowLeft", 0, 3)).toBe(2);
  expect(nextFocusIndex("ArrowUp", 1, 3)).toBe(0);
  expect(nextFocusIndex("Home", 2, 3)).toBe(0);
  expect(nextFocusIndex("End", 0, 3)).toBe(2);
  expect(nextFocusIndex("Enter", 0, 3)).toBeNull();
  expect(nextFocusIndex("ArrowRight", 0, 0)).toBeNull();
});

test("a batch member lists what its finished steps created, removed once it is merged", () => {
  const steps = resolvePlan(BLOCKED_MEMBER_SELECTION).steps;
  expect(planNodes(steps, 0, false)).toEqual([]);
  const created = planNodes(steps, steps.length, false);
  expect(created.some((n) => n.kind === "claimable" && n.id.startsWith("cb:demo_sponsored:"))).toBe(
    true
  );
  expect(created.every((n) => n.status === "docked")).toBe(true);
  expect(planNodes(steps, steps.length, true).every((n) => n.status === "destroyed")).toBe(true);
});
