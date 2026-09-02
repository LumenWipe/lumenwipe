/**
 * The invariant harness every exit adapter is tested against (architecture.md §9.9, issue #153).
 *
 * An adapter's own suite calls `describeExitAdapterInvariants` with real fixtures for its
 * protocol; the harness registers the battery of invariant tests and runs each through the real
 * `runExitAdapter`, so what is asserted is the behavior the close will actually get, not a
 * re-implementation of the rules inside the test. The adversarial suite imports the same harness
 * for its exit-adapter coverage.
 */
import { describe, expect, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { DefiPosition, DefiProtocol, Network } from "@lumenwipe/types";
import {
  MIN_RECEIVED_REQUIRED,
  assessRepayBeforeWithdraw,
  compareBaseUnits,
  runExitAdapter,
  type ExitAdapter,
  type ExitContext,
  type ExitRpc,
  type ExitRunResult,
  type SimulatedExitStep,
} from "@/lib/defi-exits";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractKind,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";

export interface HarnessScenario<P extends DefiPosition> {
  position: P;
  rpc: ExitRpc;
  /** A registry that knows (or deliberately does not know) the live code of `position`'s contract. */
  registry: ContractRegistryLookup;
}

export interface ExitAdapterHarnessInput<P extends DefiPosition, L> {
  adapter: ExitAdapter<P, L>;
  /** A position that exits cleanly against its rpc; the live balance the rpc will report. */
  healthy: HarnessScenario<P> & { liveCeiling: string };
  /** The healthy position, against an rpc whose simulation fails. */
  simulationFails: HarnessScenario<P>;
  /** Positions that must be refused, each with the blocker codes a refusal must carry. */
  blocked?: Array<HarnessScenario<P> & { name: string; expectCodes: string[] }>;
  ctx?: Partial<ExitContext>;
}

export function harnessContext(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    network: "testnet",
    account: Keypair.random().publicKey(),
    sequence: "1",
    now: new Date("2026-09-02T12:00:00Z"),
    slippageBps: 50,
    ...overrides,
  };
}

/** A registry with exactly one verified entry, for `contract` running `wasmHash`. */
export function registryKnowing(
  contract: string,
  wasmHash: string,
  protocol: DefiProtocol,
  kind: ContractKind = "pool",
  network: Network = "testnet"
): ContractRegistryLookup {
  return createContractRegistryLookup(
    validateContractRegistry({
      version: "test",
      lastVerified: "2026-09-01",
      validUntil: "2026-12-01",
      source: "harness fixture",
      entries: [
        {
          network,
          protocol,
          kind,
          address: contract,
          wasmHash,
          version: "v-test",
          label: "harness fixture",
          verifiedLive: true,
        },
      ],
    })
  );
}

export function emptyRegistry(): ContractRegistryLookup {
  return createContractRegistryLookup(
    validateContractRegistry({
      version: "test",
      lastVerified: "2026-09-01",
      validUntil: "2026-12-01",
      source: "harness fixture",
      entries: [],
    })
  );
}

function run<P extends DefiPosition, L>(
  adapter: ExitAdapter<P, L>,
  scenario: HarnessScenario<P>,
  ctx: ExitContext
): Promise<ExitRunResult> {
  return runExitAdapter(adapter, scenario.position, ctx, {
    rpc: scenario.rpc,
    resolveWasmHash: scenario.registry.resolveWasmHash,
  });
}

function codes(result: ExitRunResult): string[] {
  return result.blockers.map((b) => b.code ?? "(no code)");
}

/** Everything that must hold for every built step, regardless of protocol. */
export function expectStepInvariants(steps: SimulatedExitStep[], liveCeiling?: string): void {
  for (const built of steps) {
    const { step } = built;
    expect(compareBaseUnits(step.amount, step.ceiling)).not.toBe(1);
    if (liveCeiling !== undefined) expect(compareBaseUnits(step.amount, liveCeiling)).not.toBe(1);
    if (MIN_RECEIVED_REQUIRED.includes(step.kind)) expect(step.minReceived).not.toBeNull();
    expect(built.op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    expect(built.intent.contract).toBe(step.contract);
    expect(built.intent.function).toBe(step.function);
    expect(built.simulation.minResourceFee).toMatch(/^\d+$/);
  }
  expect(assessRepayBeforeWithdraw(steps.map((s) => s.step.kind))).toEqual([]);
}

export function describeExitAdapterInvariants<P extends DefiPosition, L>(
  name: string,
  input: ExitAdapterHarnessInput<P, L>
): void {
  const ctx = harnessContext(input.ctx);
  const { adapter, healthy } = input;

  describe(`${name}: exit adapter invariants`, () => {
    test("halts on an unknown wasmHash before reading anything", async () => {
      let readLiveCalls = 0;
      const spied: ExitAdapter<P, L> = {
        ...adapter,
        readLive: (position, c, rpc) => {
          readLiveCalls += 1;
          return adapter.readLive(position, c, rpc);
        },
      };
      const result = await run(spied, { ...healthy, registry: emptyRegistry() }, ctx);
      expect(result.steps).toEqual([]);
      expect(codes(result)).toEqual(["exit_unknown_contract_version"]);
      expect(readLiveCalls).toBe(0);
    });

    test("halts when the live code belongs to a different protocol", async () => {
      const otherProtocol: DefiProtocol = adapter.protocol === "blend" ? "soroswap" : "blend";
      const known = healthy.registry.resolveWasmHash(
        ctx.network,
        healthy.registry.registry.entries[0]?.wasmHash ?? ""
      );
      if (known.status !== "known") throw new Error("healthy registry must know its own entry");
      const registry = registryKnowing(
        healthy.position.contractAddress,
        known.wasmHash,
        otherProtocol,
        known.kind
      );
      const result = await run(adapter, { ...healthy, registry }, ctx);
      expect(result.steps).toEqual([]);
      expect(codes(result)).toEqual(["exit_contract_protocol_mismatch"]);
    });

    test("exits the healthy position: steps only, every invariant holding", async () => {
      const result = await run(adapter, healthy, ctx);
      expect(result.blockers).toEqual([]);
      expect(result.steps.length).toBeGreaterThan(0);
      expectStepInvariants(result.steps, healthy.liveCeiling);
    });

    test("amounts come from the live read, never the detection result", async () => {
      const result = await run(adapter, healthy, ctx);
      for (const { step } of result.steps) {
        expect(compareBaseUnits(step.ceiling, healthy.liveCeiling)).not.toBe(1);
      }
    });

    test("a failed simulation blocks and builds nothing", async () => {
      const result = await run(adapter, input.simulationFails, ctx);
      expect(result.steps).toEqual([]);
      expect(codes(result)).toEqual(["exit_simulation_failed"]);
    });

    test("the same state yields the same plan", async () => {
      const first = await run(adapter, healthy, ctx);
      const second = await run(adapter, healthy, ctx);
      const shape = (r: ExitRunResult): string =>
        JSON.stringify(r.steps.map((s) => ({ step: s.step, op: s.op.toXDR("base64") })));
      expect(shape(second)).toBe(shape(first));
    });

    for (const scenario of input.blocked ?? []) {
      test(`refuses ${scenario.name} with an explanation, building nothing`, async () => {
        const result = await run(adapter, scenario, ctx);
        expect(result.steps).toEqual([]);
        for (const code of scenario.expectCodes) expect(codes(result)).toContain(code);
      });
    }
  });
}
