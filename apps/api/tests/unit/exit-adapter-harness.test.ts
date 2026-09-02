/**
 * Proves the runner and the harness with the reference adapter: the harness passes against a
 * well-behaved adapter, and each knob that breaks one invariant is caught by the runner from the
 * outside - which is the whole point of enforcing them there rather than trusting each adapter.
 */
import { describe, expect, test } from "bun:test";
import { runExitAdapter } from "@/lib/defi-exits";
import {
  describeExitAdapterInvariants,
  emptyRegistry,
  harnessContext,
  registryKnowing,
} from "./fixtures/exit-adapter-harness";
import {
  fakeExitAdapter,
  fakeExitRpc,
  fakeSupplyPosition,
  type FakeAdapterKnobs,
} from "./fixtures/fake-exit-adapter";

const WASM_HASH = "c".repeat(64);
const LIVE_BALANCE = "750000000";
const position = fakeSupplyPosition({ bTokenAmount: "1000000000" }); // detection overstates
const registry = registryKnowing(position.contractAddress, WASM_HASH, "blend");
const ctx = harnessContext();

function liveRpc(simulation: "ok" | "error" = "ok") {
  return fakeExitRpc({ liveWasmHash: WASM_HASH, liveBalance: LIVE_BALANCE, simulation });
}

// The harness itself, run against the well-behaved reference adapter.
describeExitAdapterInvariants("reference adapter", {
  adapter: fakeExitAdapter(),
  healthy: { position, rpc: liveRpc(), registry, liveCeiling: LIVE_BALANCE },
  simulationFails: { position, rpc: liveRpc("error"), registry },
  ctx,
});

// Same harness, an adapter whose price-dependent step carries a floor.
describeExitAdapterInvariants("reference adapter, remove_liquidity", {
  adapter: fakeExitAdapter({ kind: "remove_liquidity" }),
  healthy: { position, rpc: liveRpc(), registry, liveCeiling: LIVE_BALANCE },
  simulationFails: { position, rpc: liveRpc("error"), registry },
  ctx,
});

async function runWith(knobs: FakeAdapterKnobs, rpc = liveRpc()) {
  return runExitAdapter(fakeExitAdapter(knobs), position, ctx, {
    rpc,
    resolveWasmHash: registry.resolveWasmHash,
  });
}

describe("runExitAdapter catches each invariant violation from outside the adapter", () => {
  test("the healthy run clamps the detected amount to the live balance and simulates", async () => {
    const rpc = liveRpc();
    const result = await runWith({}, rpc);
    expect(result.blockers).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.step.amount).toBe(LIVE_BALANCE);
    expect(result.steps[0]!.simulation.minResourceFee).toBe("12345");
    expect(rpc.simulateCalls).toHaveLength(1);
    expect(result.resolution?.status).toBe("known");
  });

  test.each<[string, FakeAdapterKnobs, string]>([
    ["an amount above the live balance", { overWithdraw: true }, "exit_amount_exceeds_balance"],
    [
      "a price-dependent step with no floor",
      { kind: "remove_liquidity", omitMinReceived: true },
      "exit_missing_min_received",
    ],
    ["a withdraw planned ahead of a repay", { withdrawBeforeRepay: true }, "withdraw_before_repay"],
    ["an intent that misdescribes the invocation", { lieInIntent: true }, "exit_intent_mismatch"],
    [
      "a classic operation where an invocation is required",
      { buildClassicOp: true },
      "exit_not_contract_invocation",
    ],
    ["a plan with neither steps nor blockers", { emptyPlan: true }, "exit_nothing_planned"],
  ])("%s -> blocked, nothing built", async (_label, knobs, code) => {
    const rpc = liveRpc();
    const result = await runWith(knobs, rpc);
    expect(result.steps).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toContain(code);
    // Nothing that failed an invariant ever reached simulation.
    expect(rpc.simulateCalls).toHaveLength(0);
  });

  test("a contract that cannot be read on the network halts before the registry is consulted", async () => {
    let resolveCalls = 0;
    const result = await runExitAdapter(fakeExitAdapter(), position, ctx, {
      rpc: fakeExitRpc({ liveWasmHash: null, liveBalance: LIVE_BALANCE }),
      resolveWasmHash: (network, hash) => {
        resolveCalls += 1;
        return registry.resolveWasmHash(network, hash);
      },
    });
    expect(result.steps).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_contract_unresolvable"]);
    expect(result.resolution).toBeNull();
    expect(resolveCalls).toBe(0);
  });

  test("a hash the registry knows only on another network is unknown here", async () => {
    const mainnetOnly = registryKnowing(
      position.contractAddress,
      WASM_HASH,
      "blend",
      "pool",
      "mainnet"
    );
    const result = await runExitAdapter(fakeExitAdapter(), position, ctx, {
      rpc: liveRpc(),
      resolveWasmHash: mainnetOnly.resolveWasmHash,
    });
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_unknown_contract_version"]);
  });

  test("the shipped registry is the default resolver, and knows none of the fixture hashes", async () => {
    const result = await runExitAdapter(fakeExitAdapter(), position, ctx, { rpc: liveRpc() });
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_unknown_contract_version"]);
  });

  test("a position the adapter does not support is a routing bug, not a blocker", async () => {
    const borrow = { ...position, positionType: "borrow" as const, dTokenAmount: "1" };
    await expect(
      runExitAdapter(fakeExitAdapter(), borrow as never, ctx, {
        rpc: liveRpc(),
        resolveWasmHash: emptyRegistry().resolveWasmHash,
      })
    ).rejects.toThrow("cannot handle a blend borrow position");
  });

  test("blocker messages are plain language - no raw host errors reach the user", async () => {
    const result = await runWith({}, liveRpc("error"));
    expect(result.blockers[0]!.message).not.toContain("HostError");
    expect(result.blockers[0]!.message).toContain("retry the analysis");
  });
});
