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
  OTHER_CONTRACT,
  fakeExitAdapter,
  fakeExitRpc,
  fakeSupplyPosition,
  type FakeAdapterKnobs,
  type FakeRpcOptions,
} from "./fixtures/fake-exit-adapter";

const WASM_HASH = "c".repeat(64);
const LIVE_BALANCE = "750000000";
const DETECTED = "1000000000";
const position = fakeSupplyPosition({ bTokenAmount: DETECTED }); // detection overstates
const registry = registryKnowing(position.contractAddress, WASM_HASH, "blend");
const ctx = harnessContext();

function liveRpc(overrides: Partial<FakeRpcOptions> = {}) {
  return fakeExitRpc({ liveWasmHash: WASM_HASH, liveBalance: LIVE_BALANCE, ...overrides });
}

const scenario = (rpc = liveRpc()) => ({ position, rpc, registry });

// The harness itself, run against the well-behaved reference adapter, in its three shapes.
describeExitAdapterInvariants("reference adapter", {
  adapter: fakeExitAdapter(),
  healthy: { ...scenario(), detectedAmount: DETECTED, liveCeiling: LIVE_BALANCE },
  simulationFails: scenario(liveRpc({ simulation: "error" })),
  simulationNeedsRestore: scenario(liveRpc({ simulation: "restore" })),
  ctx,
});

describeExitAdapterInvariants("reference adapter with debt", {
  adapter: fakeExitAdapter({ debt: true }),
  healthy: { ...scenario(), detectedAmount: DETECTED, liveCeiling: LIVE_BALANCE },
  simulationFails: scenario(liveRpc({ simulation: "error" })),
  indebted: scenario(),
  blocked: [
    {
      ...scenario(liveRpc({ liveBalance: "520000000" })),
      name: "an undercollateralized position (52 collateral against 50 debt, 110% threshold)",
      expectCodes: ["vault_undercollateralized"],
    },
  ],
  ctx,
});

describeExitAdapterInvariants("reference adapter, lp_withdraw", {
  adapter: fakeExitAdapter({ kind: "lp_withdraw" }),
  healthy: { ...scenario(), detectedAmount: DETECTED, liveCeiling: LIVE_BALANCE },
  simulationFails: scenario(liveRpc({ simulation: "error" })),
  ctx,
});

describeExitAdapterInvariants("reference adapter, externally built envelope", {
  adapter: fakeExitAdapter({ external: true }),
  healthy: { ...scenario(), detectedAmount: DETECTED, liveCeiling: LIVE_BALANCE },
  simulationFails: scenario(liveRpc({ simulation: "error" })),
  ctx,
});

async function runWith(knobs: FakeAdapterKnobs, rpc = liveRpc()) {
  return runExitAdapter(fakeExitAdapter(knobs), position, ctx, {
    rpc,
    resolveWasmHash: registry.resolveWasmHash,
    isRegistryFresh: () => true,
  });
}

describe("runExitAdapter catches each invariant violation from outside the adapter", () => {
  test("the healthy run clamps the detected amount to the live balance and simulates once", async () => {
    const rpc = liveRpc();
    const result = await runWith({}, rpc);
    expect(result.blockers).toEqual([]);
    expect(result.plan).toHaveLength(1);
    expect(result.next?.step.amount).toBe(LIVE_BALANCE);
    expect(result.next?.simulation.minResourceFee).toBe("12345");
    expect(rpc.simulateCalls).toHaveLength(1);
    expect(result.resolution?.status).toBe("known");
  });

  test("a multi-step plan is returned whole but only its first step is built and simulated", async () => {
    const rpc = liveRpc();
    const result = await runWith({ debt: true }, rpc);
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["repay", "withdraw"]);
    expect(result.next?.step.kind).toBe("repay");
    expect(rpc.simulateCalls).toHaveLength(1);
  });

  test.each<[string, FakeAdapterKnobs, string]>([
    ["an amount above the live balance", { overWithdraw: true }, "exit_amount_exceeds_balance"],
    ["a malformed amount", { malformedAmount: true }, "exit_invalid_step"],
    [
      "a price-dependent step with no floor",
      { kind: "lp_withdraw", omitMinReceived: true },
      "exit_missing_min_received",
    ],
    [
      "a price-dependent step with a zero floor",
      { kind: "swap", zeroMinReceived: true },
      "exit_missing_min_received",
    ],
    ["a withdraw planned ahead of a repay", { withdrawBeforeRepay: true }, "withdraw_before_repay"],
    ["debt with no repay planned at all", { skipRepayWithDebt: true }, "withdraw_before_repay"],
    ["an intent that misdescribes the function", { lieInIntent: true }, "exit_intent_mismatch"],
    ["an intent that routes proceeds elsewhere", { lieRecipient: true }, "exit_intent_mismatch"],
    [
      "a classic operation where an invocation is required",
      { buildClassicOp: true },
      "exit_not_contract_invocation",
    ],
    [
      "an invocation sourced from another account",
      { foreignSource: true },
      "exit_op_source_mismatch",
    ],
    ["a plan with neither steps nor blockers", { emptyPlan: true }, "exit_nothing_planned"],
    ["an adapter that throws while planning", { throwInPlan: true }, "exit_adapter_error"],
    [
      "an external envelope carrying two operations",
      { external: true, externalTwoOps: true },
      "exit_intent_mismatch",
    ],
  ])("%s -> blocked, nothing built", async (_label, knobs, code) => {
    const rpc = liveRpc();
    const result = await runWith(knobs, rpc);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toContain(code);
    // Nothing that failed an invariant ever reached simulation.
    expect(rpc.simulateCalls).toHaveLength(0);
  });

  test("a position below its liquidation threshold is refused before anything is built", async () => {
    const rpc = liveRpc({ liveBalance: "520000000" });
    const result = await runWith({ debt: true }, rpc);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["vault_undercollateralized"]);
    expect(rpc.simulateCalls).toHaveLength(0);
  });

  test("a step against a contract the registry does not know halts, even when the pool is known", async () => {
    const rpc = liveRpc({ hashesByContract: { [OTHER_CONTRACT]: "d".repeat(64) } });
    const result = await runWith({ foreignContractStep: true }, rpc);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_unknown_contract_version"]);
    expect(result.blockers[0]!.message).toContain("CAIR…DB3V");
    expect(rpc.simulateCalls).toHaveLength(0);
  });

  test("an externally built envelope is verified, simulated, and kept byte-for-byte", async () => {
    const rpc = liveRpc();
    const result = await runWith({ external: true }, rpc);
    expect(result.blockers).toEqual([]);
    if (result.next?.build.source !== "external") throw new Error("expected the external build");
    expect(result.next.simulation.txXdr).toBe(result.next.build.envelopeXdr);
    expect(rpc.simulateCalls).toHaveLength(1);
  });

  test("a locally built step is assembled from its simulation - the simulated bytes are the offered bytes", async () => {
    const result = await runWith({});
    if (result.next?.build.source !== "local") throw new Error("expected a local build");
    expect(result.next.simulation.txXdr).not.toBe("");
    // Assembly folds the resource fee into the envelope's fee.
    expect(result.next.simulation.txXdr).toContain("A");
  });

  test("a contract that cannot be read on the network halts before the registry is consulted", async () => {
    let resolveCalls = 0;
    const result = await runExitAdapter(fakeExitAdapter(), position, ctx, {
      rpc: liveRpc({ liveWasmHash: null }),
      resolveWasmHash: (network, hash) => {
        resolveCalls += 1;
        return registry.resolveWasmHash(network, hash);
      },
      isRegistryFresh: () => true,
    });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_contract_unresolvable"]);
    expect(result.resolution).toBeNull();
    expect(resolveCalls).toBe(0);
  });

  test("a network failure while reading is a blocker, not an exception", async () => {
    const rpc = liveRpc();
    const failing = {
      ...rpc,
      getLedgerEntries: async () => {
        throw new Error("ECONNRESET");
      },
    };
    const result = await runWith({}, failing as typeof rpc);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_read_failed"]);
  });

  test("a network failure while simulating is a blocker, not an exception", async () => {
    const rpc = liveRpc();
    const failing = {
      ...rpc,
      simulateTransaction: async () => {
        throw new Error("timeout");
      },
    };
    const result = await runWith({}, failing as typeof rpc);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_simulation_failed"]);
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
      isRegistryFresh: () => true,
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
    const result = await runWith({}, liveRpc({ simulation: "error" }));
    expect(result.blockers[0]!.message).not.toContain("HostError");
    expect(result.blockers[0]!.message).toContain("retry the analysis");
  });
});
