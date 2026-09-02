import type { DefiPosition, PlanBlocker } from "@lumenwipe/types";
import { Account, Address, TransactionBuilder, rpc as stellarRpc, xdr } from "@stellar/stellar-sdk";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { resolveWasmHash, type ContractResolution } from "@/lib/contract-registry";
import { readLiveWasmHash, type LedgerEntriesReader } from "@/lib/stellar/contract-instance";
import {
  MIN_RECEIVED_REQUIRED,
  type BuiltExitStep,
  type ExitAdapter,
  type ExitContext,
  type ExitRpc,
} from "./adapter";
import { assessRepayBeforeWithdraw, compareBaseUnits } from "./invariants";

/**
 * Drives one adapter over one position in the order §9.9 requires, and enforces from outside the
 * adapter every invariant that does not depend on protocol knowledge. Anything that fails yields
 * blockers and no steps - never a partial exit, because the steps of one position only make sense
 * as an ordered whole (a repay without its withdraw strands collateral; a withdraw without its
 * repay is a liquidation).
 */

export interface ExitRunDeps {
  rpc: ExitRpc;
  /** Overridable so the harness can run an adapter against a fixture registry. */
  resolveWasmHash?: typeof resolveWasmHash;
  readLiveWasmHash?: (rpc: LedgerEntriesReader, contract: string) => Promise<string | null>;
}

export interface ExitSimulation {
  minResourceFee: string;
  latestLedger: number;
}

export interface SimulatedExitStep extends BuiltExitStep {
  simulation: ExitSimulation;
}

export interface ExitRunResult {
  contract: string;
  /** The registry's verdict on the live code, null when the contract could not be read at all. */
  resolution: ContractResolution | null;
  steps: SimulatedExitStep[];
  blockers: PlanBlocker[];
}

function shortContract(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function halted(
  contract: string,
  resolution: ContractResolution | null,
  blockers: PlanBlocker[]
): ExitRunResult {
  return { contract, resolution, steps: [], blockers };
}

/** The contract and function a built operation actually invokes, or null if it is not one. */
function decodeInvocation(op: xdr.Operation): { contract: string; function: string } | null {
  if (op.body().switch() !== xdr.OperationType.invokeHostFunction()) return null;
  const host = op.body().invokeHostFunctionOp().hostFunction();
  if (host.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  const invocation = host.invokeContract();
  return {
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    function: invocation.functionName().toString(),
  };
}

export async function runExitAdapter<P extends DefiPosition, L>(
  adapter: ExitAdapter<P, L>,
  position: DefiPosition,
  ctx: ExitContext,
  deps: ExitRunDeps
): Promise<ExitRunResult> {
  const contract = position.contractAddress;
  if (!adapter.supports(position)) {
    // A routing bug, not an account state: the wrong adapter was handed this position.
    throw new Error(
      `${adapter.protocol} exit adapter cannot handle a ${position.protocol} ${position.positionType} position`
    );
  }

  // 1. Halt on unknown wasmHash - before readLive, so nothing is ever decoded against code the
  //    registry has not vouched for on this network.
  const liveHash = await (deps.readLiveWasmHash ?? readLiveWasmHash)(deps.rpc, contract);
  if (liveHash === null) {
    return halted(contract, null, [
      {
        code: "exit_contract_unresolvable",
        message:
          `The ${position.protocol} contract ${shortContract(contract)} holding this position ` +
          "could not be read on the network, so no exit was built. Verify the position on an " +
          "explorer before proceeding.",
      },
    ]);
  }
  const resolution = (deps.resolveWasmHash ?? resolveWasmHash)(ctx.network, liveHash);
  if (resolution.status === "unknown") {
    return halted(contract, resolution, [
      {
        code: "exit_unknown_contract_version",
        message:
          `The ${position.protocol} contract ${shortContract(contract)} is running a code version ` +
          "LumenWipe has not verified, so no exit was built. This position needs manual review.",
      },
    ]);
  }
  if (resolution.protocol !== adapter.protocol) {
    return halted(contract, resolution, [
      {
        code: "exit_contract_protocol_mismatch",
        message:
          `The contract ${shortContract(contract)} was detected as a ${position.protocol} position ` +
          `but its code is registered as ${resolution.protocol}. No exit was built; this position ` +
          "needs manual review.",
      },
    ]);
  }

  // 2. Live re-read, then the adapter's pure plan.
  const live = await adapter.readLive(position, ctx, deps.rpc);
  const plan = adapter.plan(position, live, ctx);
  if (plan.blockers.length > 0) return halted(contract, resolution, plan.blockers);
  if (plan.steps.length === 0) {
    return halted(contract, resolution, [
      {
        code: "exit_nothing_planned",
        message:
          `The ${position.protocol} adapter produced no steps and no explanation for this ` +
          "position. Nothing was built; this position needs manual review.",
      },
    ]);
  }

  // 3. Invariants the adapter is not trusted to keep on its own.
  const blockers: PlanBlocker[] = [];
  for (const step of plan.steps) {
    if (compareBaseUnits(step.amount, step.ceiling) > 0) {
      blockers.push({
        code: "exit_amount_exceeds_balance",
        message:
          `The planned ${step.kind} of this ${position.protocol} position exceeds the balance ` +
          "read from the network just now. Nothing was built; retry the analysis.",
      });
    }
    if (MIN_RECEIVED_REQUIRED.includes(step.kind) && step.minReceived === null) {
      blockers.push({
        code: "exit_missing_min_received",
        message:
          `The planned ${step.kind} of this ${position.protocol} position has no minimum-received ` +
          "floor, so it could execute at any price. Nothing was built.",
      });
    }
  }
  blockers.push(...assessRepayBeforeWithdraw(plan.steps.map((s) => s.kind)));
  if (blockers.length > 0) return halted(contract, resolution, blockers);

  // 4. Build each step, check the intent against the bytes, and simulate before it is offered.
  const passphrase = NETWORK_PASSPHRASES[ctx.network];
  const steps: SimulatedExitStep[] = [];
  for (const step of plan.steps) {
    const built = adapter.buildStep(step, live, ctx);
    const invocation = decodeInvocation(built.op);
    if (!invocation) {
      return halted(contract, resolution, [
        {
          code: "exit_not_contract_invocation",
          message:
            `The ${step.kind} step for this ${position.protocol} position did not build as a ` +
            "contract invocation. Nothing was built.",
        },
      ]);
    }
    if (
      invocation.contract !== built.intent.contract ||
      invocation.function !== built.intent.function ||
      built.intent.contract !== step.contract
    ) {
      return halted(contract, resolution, [
        {
          code: "exit_intent_mismatch",
          message:
            `The ${step.kind} step for this ${position.protocol} position describes itself ` +
            "differently from what it would execute. Nothing was built.",
        },
      ]);
    }

    const tx = new TransactionBuilder(new Account(ctx.account, ctx.sequence), {
      fee: String(BASE_FEE_STROOPS),
      networkPassphrase: passphrase,
    })
      .addOperation(built.op)
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
    const simulation = await deps.rpc.simulateTransaction(tx);
    if (stellarRpc.Api.isSimulationError(simulation)) {
      return halted(contract, resolution, [
        {
          code: "exit_simulation_failed",
          message:
            `Simulating the ${step.kind} of this ${position.protocol} position failed on the ` +
            "network, so nothing was built. The position may have changed; retry the analysis, " +
            "and if it keeps failing it needs manual review.",
        },
      ]);
    }
    steps.push({
      ...built,
      simulation: {
        minResourceFee: simulation.minResourceFee,
        latestLedger: simulation.latestLedger,
      },
    });
  }

  return { contract, resolution, steps, blockers: [] };
}
