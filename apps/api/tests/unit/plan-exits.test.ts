import { describe, expect, test } from "bun:test";
import type { BlendSupplyPosition, DefiPosition, SoroswapLpPosition } from "@lumenwipe/types";
import { groupExitTargets, planExitSteps } from "@/lib/defi-exits/plan-exits";

const POOL_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const POOL_B = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

function blendSupply(
  contract: string,
  over: Partial<BlendSupplyPosition> = {}
): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: contract,
    assetAddress: POOL_B,
    bTokenAmount: "1",
    usdValue: null,
    ...over,
  };
}

function soroswapLp(contract: string): SoroswapLpPosition {
  return {
    protocol: "soroswap",
    positionType: "lp",
    contractAddress: contract,
    shareAmount: "1",
    usdValue: null,
  };
}

describe("groupExitTargets", () => {
  test("one target per protocol and contract, positions kept together", () => {
    const targets = groupExitTargets([
      blendSupply(POOL_A),
      {
        ...blendSupply(POOL_A),
        positionType: "borrow",
        dTokenAmount: "1",
      } as unknown as DefiPosition,
      blendSupply(POOL_B),
    ]);
    expect(targets.map((t) => [t.contract, t.positions.length])).toEqual([
      [POOL_A, 2],
      [POOL_B, 1],
    ]);
  });

  test("is deterministic regardless of detection order", () => {
    const a = groupExitTargets([blendSupply(POOL_B), soroswapLp(POOL_A), blendSupply(POOL_A)]);
    const b = groupExitTargets([blendSupply(POOL_A), blendSupply(POOL_B), soroswapLp(POOL_A)]);
    expect(a.map((t) => `${t.protocol}:${t.contract}`)).toEqual(
      b.map((t) => `${t.protocol}:${t.contract}`)
    );
    expect(a.map((t) => t.protocol)).toEqual(["blend", "blend", "soroswap"]);
  });
});

describe("planExitSteps", () => {
  test("one EXIT_POSITIONS step per exitable target, indexed from where the plan is", () => {
    const { steps, blockers } = planExitSteps(
      [blendSupply(POOL_A), blendSupply(POOL_A, { assetAddress: POOL_A }), blendSupply(POOL_B)],
      7
    );
    expect(blockers).toEqual([]);
    expect(steps.map((s) => [s.index, s.type, s.affectedContract, s.operationCount])).toEqual([
      [7, "EXIT_POSITIONS", POOL_A, 2],
      [8, "EXIT_POSITIONS", POOL_B, 1],
    ]);
    expect(steps[0]!.title).toBe("Exit Blend CAAA…BSC4");
    expect(steps[0]!.description).toContain("withdraw 2 positions");
  });

  test("a protocol without an adapter blocks by name instead of being left out", () => {
    const { steps, blockers } = planExitSteps([soroswapLp(POOL_A)], 0);
    expect(steps).toEqual([]);
    expect(blockers.map((b) => b.code)).toEqual(["defi_exit_unsupported"]);
    expect(blockers[0]!.message).toContain("Soroswap");
  });

  test("a target whose positions the adapter refuses (backstop only) blocks too", () => {
    const { steps, blockers } = planExitSteps([blendSupply(POOL_A, { isBackstop: true })], 0);
    expect(steps).toEqual([]);
    expect(blockers.map((b) => b.code)).toEqual(["defi_exit_unsupported"]);
  });

  test("no positions, no steps, no blockers", () => {
    expect(planExitSteps([], 3)).toEqual({ steps: [], blockers: [] });
  });
});
