import { describe, expect, test } from "bun:test";
import type { BlendSupplyPosition, DefiPosition, PhoenixLpPosition } from "@lumenwipe/types";
import {
  DEFI_POSITION_LEFT_BEHIND_CODE,
  groupExitTargets,
  planExitSteps,
  type ExitTargetBlock,
} from "@/lib/defi-exits/plan-exits";

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

function phoenixLp(contract: string): PhoenixLpPosition {
  return {
    protocol: "phoenix",
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
    const a = groupExitTargets([blendSupply(POOL_B), phoenixLp(POOL_A), blendSupply(POOL_A)]);
    const b = groupExitTargets([blendSupply(POOL_A), blendSupply(POOL_B), phoenixLp(POOL_A)]);
    expect(a.map((t) => `${t.protocol}:${t.contract}`)).toEqual(
      b.map((t) => `${t.protocol}:${t.contract}`)
    );
    expect(a.map((t) => t.protocol)).toEqual(["blend", "blend", "phoenix"]);
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
    // xBull is a swap router, never a DeFi position with an exit adapter (see PROTOCOL_LABEL's
    // own comment in plan-exits.ts); this fixture stands in for "detection reports a protocol
    // the catalog has no adapter for" now that all five real position-bearing protocols do.
    const xbullPosition = { ...phoenixLp(POOL_A), protocol: "xbull" } as unknown as DefiPosition;
    const { steps, blockers } = planExitSteps([xbullPosition], 0);
    expect(steps).toEqual([]);
    expect(blockers.map((b) => b.code)).toEqual(["defi_exit_unsupported"]);
    expect(blockers[0]!.message).toContain("xBull");
  });

  test("a backstop deposit is the Blend adapter's too: alone or beside a supply, one exit step", () => {
    const alone = planExitSteps([blendSupply(POOL_A, { isBackstop: true })], 0);
    expect(alone.blockers).toEqual([]);
    expect(alone.steps.map((s) => s.type)).toEqual(["EXIT_POSITIONS"]);
    const both = planExitSteps([blendSupply(POOL_A), blendSupply(POOL_A, { isBackstop: true })], 0);
    expect(both.blockers).toEqual([]);
    expect(both.steps).toHaveLength(1);
    expect(both.steps[0]!.operationCount).toBe(2);
  });

  test("no positions, no steps, no blockers", () => {
    expect(planExitSteps([], 3)).toEqual({ steps: [], blockers: [], leavable: [] });
  });
});

describe("planExitSteps with a preflight", () => {
  const simFails: ExitTargetBlock = {
    code: "exit_simulation_failed",
    message: "Simulating the withdraw of this Blend position failed on the network.",
    leaveEligible: true,
  };

  test("a target whose exit cannot be built blocks the merge by name and value, and is leavable", () => {
    const result = planExitSteps(
      [blendSupply(POOL_A, { usdValue: "10.50" }), blendSupply(POOL_B)],
      0,
      { blocked: new Map([[POOL_A, simFails]]), leftBehind: new Set() }
    );
    expect(result.steps.map((s) => s.affectedContract)).toEqual([POOL_B]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.code).toBe("exit_simulation_failed");
    expect(result.blockers[0]!.message).toContain("CAAA…BSC4");
    expect(result.blockers[0]!.message).toContain("about $10.50");
    expect(result.blockers[0]!.message).toContain("cannot be merged");
    expect(result.leavable).toEqual([
      {
        protocol: "blend",
        label: "Blend",
        contract: POOL_A,
        positionCount: 1,
        usdValue: "10.50",
        reason: simFails.message,
      },
    ]);
  });

  test("once the user leaves it behind, the blocker becomes a recorded, non-trapping warning", () => {
    const result = planExitSteps([blendSupply(POOL_A)], 0, {
      blocked: new Map([[POOL_A, simFails]]),
      leftBehind: new Set([POOL_A]),
    });
    expect(result.steps).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toEqual([DEFI_POSITION_LEFT_BEHIND_CODE]);
    expect(result.blockers[0]!.message).toContain("value unknown");
    expect(result.leavable.map((t) => t.contract)).toEqual([POOL_A]);
  });

  test("a blocker that is not leave-eligible stays a hard blocker even with a leave answer", () => {
    const result = planExitSteps([blendSupply(POOL_A)], 0, {
      blocked: new Map([
        [
          POOL_A,
          { code: "exit_read_failed", message: "Retry the analysis.", leaveEligible: false },
        ],
      ]),
      leftBehind: new Set([POOL_A]),
    });
    expect(result.steps).toEqual([]);
    expect(result.blockers).toEqual([{ code: "exit_read_failed", message: "Retry the analysis." }]);
    expect(result.leavable).toEqual([]);
  });

  test("a leave answer for a target whose exit builds changes nothing: it is exited", () => {
    const result = planExitSteps([blendSupply(POOL_A)], 0, {
      blocked: new Map(),
      leftBehind: new Set([POOL_A]),
    });
    expect(result.steps.map((s) => s.affectedContract)).toEqual([POOL_A]);
    expect(result.blockers).toEqual([]);
    expect(result.leavable).toEqual([]);
  });

  test("a target without an adapter is leavable too", () => {
    const xbullPosition = { ...phoenixLp(POOL_A), protocol: "xbull" } as unknown as DefiPosition;
    const left = planExitSteps([xbullPosition], 0, {
      blocked: new Map(),
      leftBehind: new Set([POOL_A]),
    });
    expect(left.blockers.map((b) => b.code)).toEqual([DEFI_POSITION_LEFT_BEHIND_CODE]);
  });

  test("the value is the positions' sum, and unknown when any one of them is", () => {
    const summed = planExitSteps(
      [blendSupply(POOL_A, { usdValue: "1.25" }), blendSupply(POOL_A, { usdValue: "2.80" })],
      0,
      { blocked: new Map([[POOL_A, simFails]]), leftBehind: new Set() }
    );
    expect(summed.leavable[0]!.usdValue).toBe("4.05");
    expect(summed.blockers[0]!.message).toContain("the 2 Blend positions in CAAA…BSC4");
    const partial = planExitSteps(
      [blendSupply(POOL_A, { usdValue: "1.25" }), blendSupply(POOL_A)],
      0,
      { blocked: new Map([[POOL_A, simFails]]), leftBehind: new Set() }
    );
    expect(partial.leavable[0]!.usdValue).toBeNull();
    const withDebt = planExitSteps(
      [
        blendSupply(POOL_A, { usdValue: "100.00" }),
        {
          ...blendSupply(POOL_A, { usdValue: "80.00" }),
          positionType: "borrow",
          dTokenAmount: "1",
        } as unknown as DefiPosition,
      ],
      0,
      { blocked: new Map([[POOL_A, simFails]]), leftBehind: new Set() }
    );
    expect(withDebt.leavable[0]!.usdValue).toBe("20.00");
  });
});
