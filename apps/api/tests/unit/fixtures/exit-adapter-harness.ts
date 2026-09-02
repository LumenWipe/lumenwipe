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
  WITHDRAWAL_KINDS,
  assessRepayBeforeWithdraw,
  compareBaseUnits,
  runExitAdapter,
  type ExitAdapter,
  type ExitContext,
  type ExitRpc,
  type ExitRunResult,
  type ExitStep,
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
  /**
   * A position that exits cleanly against its rpc. `detectedAmount` is what detection reported
   * and `liveCeiling` what the rpc reports live; the fixture must overstate detection, otherwise
   * the "amounts come from the live read" test proves nothing.
   */
  healthy: HarnessScenario<P> & { detectedAmount: string; liveCeiling: string };
  /** The healthy position, against an rpc whose simulation fails. */
  simulationFails: HarnessScenario<P>;
  /** The healthy position, against an rpc whose simulation needs archived entries restored. */
  simulationNeedsRestore?: HarnessScenario<P>;
  /** A position with debt: its plan must repay before it withdraws, and exit cleanly. */
  indebted?: HarnessScenario<P>;
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

/**
 * Delegates every method explicitly rather than spreading, so an adapter written as a class (with
 * its methods on the prototype) is observed just as well as an object literal.
 */
function observe<P extends DefiPosition, L>(
  adapter: ExitAdapter<P, L>,
  calls: string[]
): ExitAdapter<P, L> {
  return {
    protocol: adapter.protocol,
    supports: (position): position is P => adapter.supports(position),
    readLive: (position, ctx, rpc) => {
      calls.push("readLive");
      return adapter.readLive(position, ctx, rpc);
    },
    plan: (position, live, code, ctx) => {
      calls.push("plan");
      return adapter.plan(position, live, code, ctx);
    },
    health: (position, live, steps) => adapter.health(position, live, steps),
    buildStep: (step, live, ctx) => {
      calls.push("buildStep");
      return adapter.buildStep(step, live, ctx);
    },
  };
}

function run<P extends DefiPosition, L>(
  adapter: ExitAdapter<P, L>,
  scenario: HarnessScenario<P>,
  ctx: ExitContext,
  fresh: () => boolean = () => true
): Promise<ExitRunResult> {
  return runExitAdapter(adapter, scenario.position, ctx, {
    rpc: scenario.rpc,
    resolveWasmHash: scenario.registry.resolveWasmHash,
    isRegistryFresh: fresh,
  });
}

function codes(result: ExitRunResult): string[] {
  return result.blockers.map((b) => b.code ?? "(no code)");
}

/** What must hold for every declared step of a plan, regardless of protocol. */
export function expectPlanInvariants(plan: ExitStep[], liveCeiling?: string): void {
  for (const step of plan) {
    expect(compareBaseUnits(step.amount, step.ceiling)).not.toBe(1);
    if (liveCeiling !== undefined && WITHDRAWAL_KINDS.includes(step.kind)) {
      expect(compareBaseUnits(step.amount, liveCeiling)).not.toBe(1);
    }
    if (MIN_RECEIVED_REQUIRED.includes(step.kind))
      expect(step.minReceived.length).toBeGreaterThan(0);
    for (const floor of step.minReceived) expect(compareBaseUnits(floor.amount, "0")).toBe(1);
  }
  expect(assessRepayBeforeWithdraw(plan.map((s) => s.kind))).toEqual([]);
}

/** What must hold for the built, simulated step. */
export function expectBuiltInvariants(next: SimulatedExitStep, ctx: ExitContext): void {
  expect(next.intent.contract).toBe(next.step.contract);
  expect(next.intent.function).toBe(next.step.function);
  expect(next.intent.recipient).toBe(ctx.account);
  expect(next.simulation.minResourceFee).toMatch(/^\d+$/);
  const envelope = xdr.TransactionEnvelope.fromXDR(next.simulation.txXdr, "base64");
  const ops = envelope.v1().tx().operations();
  expect(ops).toHaveLength(1);
  expect(ops[0]!.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
}

export function describeExitAdapterInvariants<P extends DefiPosition, L>(
  name: string,
  input: ExitAdapterHarnessInput<P, L>
): void {
  const ctx = harnessContext(input.ctx);
  const { adapter, healthy } = input;

  describe(`${name}: exit adapter invariants`, () => {
    test("the healthy fixture overstates detection, so the live-read test can mean something", () => {
      expect(compareBaseUnits(healthy.detectedAmount, healthy.liveCeiling)).toBe(1);
    });

    test("halts on an unknown wasmHash before reading anything", async () => {
      const calls: string[] = [];
      const result = await run(
        observe(adapter, calls),
        { ...healthy, registry: emptyRegistry() },
        ctx
      );
      expect(result.next).toBeNull();
      expect(codes(result)).toEqual(["exit_unknown_contract_version"]);
      expect(calls).toEqual([]);
    });

    test("halts when the live code belongs to a different protocol", async () => {
      const own = healthy.registry.registry.entries.find(
        (e) => e.address === healthy.position.contractAddress && e.network === ctx.network
      );
      if (!own?.wasmHash) throw new Error("healthy registry must know the position's contract");
      const otherProtocol: DefiProtocol = adapter.protocol === "blend" ? "soroswap" : "blend";
      const registry = registryKnowing(own.address, own.wasmHash, otherProtocol, own.kind);
      const result = await run(adapter, { ...healthy, registry }, ctx);
      expect(result.next).toBeNull();
      expect(codes(result)).toEqual(["exit_contract_protocol_mismatch"]);
    });

    test("halts when the registry is past its verification window", async () => {
      const calls: string[] = [];
      const result = await run(observe(adapter, calls), healthy, ctx, () => false);
      expect(result.next).toBeNull();
      expect(codes(result)).toEqual(["exit_registry_expired"]);
      expect(calls).toEqual([]);
    });

    test("exits the healthy position: a plan, a built first step, every invariant holding", async () => {
      const result = await run(adapter, healthy, ctx);
      expect(result.blockers).toEqual([]);
      expect(result.plan.length).toBeGreaterThan(0);
      expectPlanInvariants(result.plan, healthy.liveCeiling);
      if (!result.next) throw new Error("expected a built first step");
      expect(result.next.step).toEqual(result.plan[0]!);
      expectBuiltInvariants(result.next, ctx);
    });

    test("reads live state exactly once, before planning and before building", async () => {
      const calls: string[] = [];
      await run(observe(adapter, calls), healthy, ctx);
      expect(calls.filter((c) => c === "readLive")).toHaveLength(1);
      expect(calls.indexOf("readLive")).toBeLessThan(calls.indexOf("plan"));
      expect(calls.indexOf("plan")).toBeLessThan(calls.indexOf("buildStep"));
    });

    test("a failed simulation blocks and builds nothing", async () => {
      const result = await run(adapter, input.simulationFails, ctx);
      expect(result.next).toBeNull();
      expect(codes(result)).toEqual(["exit_simulation_failed"]);
    });

    if (input.simulationNeedsRestore) {
      test("a simulation that needs archived entries restored blocks instead of offering a doomed step", async () => {
        const result = await run(adapter, input.simulationNeedsRestore!, ctx);
        expect(result.next).toBeNull();
        expect(codes(result)).toEqual(["exit_needs_restore"]);
      });
    }

    test("the same state yields the same plan and the same bytes", async () => {
      const first = await run(adapter, healthy, ctx);
      const second = await run(adapter, healthy, ctx);
      const shape = (r: ExitRunResult): string =>
        JSON.stringify({ plan: r.plan, xdr: r.next?.simulation.txXdr ?? null });
      expect(shape(second)).toBe(shape(first));
    });

    if (input.indebted) {
      test("a position with debt repays before it withdraws, and builds the repay first", async () => {
        const result = await run(adapter, input.indebted!, ctx);
        expect(result.blockers).toEqual([]);
        const kinds = result.plan.map((s) => s.kind);
        const firstWithdrawal = kinds.findIndex((k) => WITHDRAWAL_KINDS.includes(k));
        expect(kinds.indexOf("repay")).not.toBe(-1);
        if (firstWithdrawal !== -1) expect(kinds.indexOf("repay")).toBeLessThan(firstWithdrawal);
        expect(result.next?.step.kind).toBe(kinds[0]!);
      });
    }

    for (const scenario of input.blocked ?? []) {
      test(`refuses ${scenario.name} with an explanation, building nothing`, async () => {
        const result = await run(adapter, scenario, ctx);
        expect(result.next).toBeNull();
        for (const code of scenario.expectCodes) expect(codes(result)).toContain(code);
      });
    }
  });
}
