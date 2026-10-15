import type { DefiPosition, PlanBlocker } from "@lumenwipe/types";
import {
  Account,
  Address,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc as stellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  BASE_FEE_STROOPS,
  EXIT_SIMULATION_CPU_LEEWAY,
  MAX_SOROBAN_EXIT_FEE_STROOPS,
  TX_TIMEOUT_SECONDS,
} from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { isRegistryFresh, resolveWasmHash, type ContractResolution } from "@/lib/contract-registry";
import { readLiveWasmHash, type LedgerEntriesReader } from "@/lib/stellar/contract-instance";
import {
  MIN_RECEIVED_REQUIRED,
  type BuiltExitStep,
  type ExitAdapter,
  type ExitContext,
  type ExitRpc,
  type ExitStep,
} from "./adapter";
import {
  assessHealthFactor,
  assessRepayBeforeWithdraw,
  assessRepayPlanned,
  compareBaseUnits,
  isBaseUnits,
} from "./invariants";

/**
 * Drives one adapter over one position in the order §9.9 requires, and enforces from outside the
 * adapter every invariant that does not depend on protocol knowledge. Anything that fails - an
 * invariant, a network read, an adapter throwing - yields blockers and no built step, never a
 * partial exit or an exception, because the caller is a close plan and a close plan speaks in
 * blockers. The one exception is handing the runner a position its adapter does not support:
 * that is a routing bug in the caller, and it throws.
 */

export interface ExitRunDeps {
  rpc: ExitRpc;
  /** Overridable so the harness can run an adapter against a fixture registry. */
  resolveWasmHash?: typeof resolveWasmHash;
  isRegistryFresh?: typeof isRegistryFresh;
  readLiveWasmHash?: (rpc: LedgerEntriesReader, contract: string) => Promise<string | null>;
}

export interface ExitSimulation {
  minResourceFee: string;
  latestLedger: number;
  /** The exact envelope that was simulated, assembled from the simulation - the bytes to sign. */
  txXdr: string;
}

export interface SimulatedExitStep extends BuiltExitStep {
  simulation: ExitSimulation;
}

export interface ExitRunResult {
  contract: string;
  /** The registry's verdict on the position's contract; null when it could not be read at all. */
  resolution: ContractResolution | null;
  /** The whole ordered plan, for the review screen. */
  plan: ExitStep[];
  /** The first step, built and simulated - the only one executable against the current ledger.
   *  Later steps are re-planned against fresh state once it confirms. Null when blocked. */
  next: SimulatedExitStep | null;
  blockers: PlanBlocker[];
  /** True when the blockers mean this tool cannot exit the position at all (unverified or
   *  unsupported code, a failing or overpriced simulation, archived data, a third party's
   *  signature, an adapter that cannot handle it), as opposed to a failed read, an expired
   *  registry, an unsafe position or a state the user can fix. Only then may a close leave the
   *  position behind, and only on the user's explicit choice. Absent means false. */
  leaveEligible?: boolean;
}

/** Adapter blocker codes that mean the position is beyond what this tool can exit. */
const ADAPTER_UNEXITABLE_CODES: ReadonlySet<string> = new Set([
  "aquarius_contract_not_pool",
  "aquarius_pool_type_unsupported",
  "aquarius_position_too_small",
  "blend_contract_not_pool",
  "blend_pool_version_unsupported",
  "fxdao_contract_not_vault",
  "phoenix_contract_not_pool",
  "phoenix_position_too_small",
  "soroswap_contract_not_pair",
  "soroswap_pair_foreign_factory",
  "soroswap_position_too_small",
]);

function shortContract(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function blocked(
  contract: string,
  resolution: ContractResolution | null,
  plan: ExitStep[],
  blockers: PlanBlocker[],
  leaveEligible = false
): ExitRunResult {
  return { contract, resolution, plan, next: null, blockers, leaveEligible };
}

function blocker(code: string, message: string): PlanBlocker {
  return { code, message };
}

/** The contract and function an operation actually invokes, or null if it is not an invocation. */
/**
 * The transaction as the signer sees it, minus the two fields a post-assembly hook may change: the
 * fee and the Soroban resource data (footprint, resources, resource fee). Two transactions with the
 * same shape do the same thing.
 */
function signedShape(tx: Transaction): string {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("the transaction is not a v1 envelope");
  const inner = envelope.v1.tx;
  return new xdr.Transaction({
    sourceAccount: inner.sourceAccount,
    fee: 0,
    seqNum: inner.seqNum,
    cond: inner.cond,
    memo: inner.memo,
    operations: inner.operations,
    ext: xdr.TransactionExt.v0(),
  }).toXdr("base64");
}

function decodeInvocation(op: xdr.Operation): { contract: string; function: string } | null {
  if (op.body.type !== "invokeHostFunction") return null;
  const host = op.body.invokeHostFunctionOp.hostFunction;
  if (host.type !== "hostFunctionTypeInvokeContract") return null;
  const invocation = host.invokeContract;
  return {
    contract: Address.fromScAddress(invocation.contractAddress).toString(),
    function: invocation.functionName.toString(),
  };
}

/** The account an operation's source field names, or null when it inherits the transaction's. */
function operationSource(op: xdr.Operation): string | null {
  const source = op.sourceAccount;
  if (!source) return null;
  if (source.type !== "keyTypeEd25519") throw new Error("the operation source is a muxed account");
  return Address.account(source.ed25519.toBytes()).toString();
}

/** How far a step that the contract clamps may over-ask, so "a small margin" stays small. */
export const MAX_CLAMPED_OVER_ASK_BPS = 100;

/** The most a step may ask for: its live ceiling, plus the bounded margin when the contract clamps. */
function allowedMaximum(step: ExitStep): string {
  if (!step.clampsToPosition) return step.ceiling;
  return ((BigInt(step.ceiling) * BigInt(10_000 + MAX_CLAMPED_OVER_ASK_BPS)) / 10_000n).toString();
}

function sameFloors(
  a: BuiltExitStep["intent"]["minReceived"],
  b: ExitStep["minReceived"]
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runExitAdapter<P extends DefiPosition, L>(
  adapter: ExitAdapter<P, L>,
  position: DefiPosition,
  ctx: ExitContext,
  deps: ExitRunDeps
): Promise<ExitRunResult> {
  const contract = position.contractAddress;
  const protocol = position.protocol;
  if (!adapter.supports(position)) {
    throw new Error(
      `${adapter.protocol} exit adapter cannot handle a ${protocol} ${position.positionType} position`
    );
  }
  const readHash = deps.readLiveWasmHash ?? readLiveWasmHash;
  const resolve = deps.resolveWasmHash ?? resolveWasmHash;
  const fresh = deps.isRegistryFresh ?? isRegistryFresh;

  // 1. A registry past its verification window vouches for nothing.
  if (!fresh(ctx.now)) {
    return blocked(
      contract,
      null,
      [],
      [
        blocker(
          "exit_registry_expired",
          "LumenWipe's record of verified DeFi contract versions is out of date, so no exit was " +
            "built for this position. It needs manual review until the record is refreshed."
        ),
      ]
    );
  }

  // 2. Halt on unknown wasmHash for the position's contract - before readLive, so nothing is
  //    ever decoded against code the registry has not vouched for on this network.
  const gate = async (
    address: string
  ): Promise<{
    resolution: ContractResolution | null;
    blockers: PlanBlocker[];
    leaveEligible: boolean;
  }> => {
    let liveHash: string | null;
    try {
      liveHash = await readHash(deps.rpc, address);
    } catch {
      return {
        resolution: null,
        blockers: [
          blocker(
            "exit_read_failed",
            `The ${protocol} contract ${shortContract(address)} could not be read from the network ` +
              "right now, so no exit was built. Retry the analysis."
          ),
        ],
        leaveEligible: false,
      };
    }
    if (liveHash === null) {
      return {
        resolution: null,
        blockers: [
          blocker(
            "exit_contract_unresolvable",
            `The ${protocol} contract ${shortContract(address)} holding this position could not ` +
              "be found on the network, so no exit was built. Verify the position on an explorer " +
              "before proceeding."
          ),
        ],
        leaveEligible: true,
      };
    }
    const resolution = resolve(ctx.network, liveHash);
    if (resolution.status === "unknown") {
      return {
        resolution,
        blockers: [
          blocker(
            "exit_unknown_contract_version",
            `The ${protocol} contract ${shortContract(address)} is running a code version ` +
              "LumenWipe has not verified, so no exit was built. This position needs manual review."
          ),
        ],
        leaveEligible: true,
      };
    }
    if (resolution.protocol !== adapter.protocol) {
      return {
        resolution,
        blockers: [
          blocker(
            "exit_contract_protocol_mismatch",
            `The contract ${shortContract(address)} was detected as a ${protocol} position but its ` +
              `code is registered as ${resolution.protocol}. No exit was built; this position ` +
              "needs manual review."
          ),
        ],
        leaveEligible: true,
      };
    }
    return { resolution, blockers: [], leaveEligible: false };
  };

  const primary = await gate(contract);
  if (primary.blockers.length > 0 || primary.resolution?.status !== "known") {
    return blocked(contract, primary.resolution, [], primary.blockers, primary.leaveEligible);
  }
  const resolution = primary.resolution;

  // 3. Live re-read, then the adapter's pure plan.
  const code = { version: resolution.version, kind: resolution.kind };
  let live: L;
  try {
    live = await adapter.readLive(position, code, ctx, deps.rpc);
  } catch {
    return blocked(
      contract,
      resolution,
      [],
      [
        blocker(
          "exit_read_failed",
          `This ${protocol} position's live state could not be read from the network right now, ` +
            "so no exit was built. Retry the analysis."
        ),
      ]
    );
  }

  const adapterError = (phase: string): ExitRunResult =>
    blocked(
      contract,
      resolution,
      [],
      [
        blocker(
          "exit_adapter_error",
          `LumenWipe could not ${phase} an exit for this ${protocol} position. Nothing was built; ` +
            "this position needs manual review."
        ),
      ],
      true
    );

  let steps: ExitStep[];
  try {
    const plan = adapter.plan(position, live, code, ctx);
    if (plan.blockers.length > 0) {
      const unexitable = plan.blockers.every(
        (b) => b.code !== undefined && ADAPTER_UNEXITABLE_CODES.has(b.code)
      );
      return blocked(contract, resolution, plan.steps, plan.blockers, unexitable);
    }
    steps = plan.steps;
  } catch {
    return adapterError("plan");
  }
  if (steps.length === 0) {
    return blocked(
      contract,
      resolution,
      [],
      [
        blocker(
          "exit_nothing_planned",
          `The ${protocol} adapter produced no steps and no explanation for this position. ` +
            "Nothing was built; this position needs manual review."
        ),
      ],
      true
    );
  }

  // 4. Invariants over the declared plan, none of which the adapter is trusted to keep alone.
  const blockers: PlanBlocker[] = [];
  for (const step of steps) {
    if (
      !isBaseUnits(step.amount) ||
      !isBaseUnits(step.ceiling) ||
      !StrKey.isValidContract(step.contract) ||
      !Array.isArray(step.minReceived)
    ) {
      blockers.push(
        blocker(
          "exit_invalid_step",
          `The planned ${step.kind} of this ${protocol} position is malformed. Nothing was built; ` +
            "this position needs manual review."
        )
      );
      continue;
    }
    if (compareBaseUnits(step.amount, allowedMaximum(step)) > 0) {
      blockers.push(
        blocker(
          "exit_amount_exceeds_balance",
          `The planned ${step.kind} of this ${protocol} position exceeds the balance read from ` +
            "the network just now. Nothing was built; retry the analysis."
        )
      );
    }
    const floorless = step.minReceived.some((m) => !isBaseUnits(m.amount) || m.amount === "0");
    if (floorless || (MIN_RECEIVED_REQUIRED.includes(step.kind) && step.minReceived.length === 0)) {
      blockers.push(
        blocker(
          "exit_missing_min_received",
          `The planned ${step.kind} of this ${protocol} position has no positive minimum-received ` +
            "floor, so it could execute at any price. Nothing was built."
        )
      );
    }
  }
  if (blockers.length > 0) return blocked(contract, resolution, steps, blockers);

  const kinds = steps.map((s) => s.kind);
  blockers.push(...assessRepayBeforeWithdraw(kinds));
  try {
    const health = adapter.health(position, live, steps);
    if (health) {
      blockers.push(...assessRepayPlanned(health, kinds));
      blockers.push(...assessHealthFactor(health));
    }
  } catch {
    return adapterError("assess the health of");
  }
  if (blockers.length > 0) return blocked(contract, resolution, steps, blockers);

  // 5. Every other contract the plan touches must be vouched for too.
  for (const other of new Set(steps.map((s) => s.contract))) {
    if (other === contract) continue;
    const check = await gate(other);
    if (check.blockers.length > 0) {
      return blocked(contract, resolution, steps, check.blockers, check.leaveEligible);
    }
  }

  // 6. Build the first step, check the claim against the bytes, simulate before it is offered.
  const step = steps[0]!;
  let built: BuiltExitStep;
  try {
    built = adapter.buildStep(step, live, ctx);
  } catch {
    return adapterError("build");
  }
  const intentMismatch = blocked(contract, resolution, steps, [
    blocker(
      "exit_intent_mismatch",
      `The ${step.kind} step for this ${protocol} position describes itself differently from ` +
        "what it would execute. Nothing was built."
    ),
  ]);
  if (
    built.intent.contract !== step.contract ||
    built.intent.function !== step.function ||
    built.intent.recipient !== ctx.account ||
    !sameFloors(built.intent.minReceived, step.minReceived)
  ) {
    return intentMismatch;
  }

  const passphrase = NETWORK_PASSPHRASES[ctx.network];
  let tx: Transaction;
  let op: xdr.Operation;
  if (built.build.source === "local") {
    op = built.build.op;
    tx = new TransactionBuilder(new Account(ctx.account, ctx.sequence), {
      fee: String(BASE_FEE_STROOPS),
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
  } else {
    let parsed: Transaction;
    try {
      const envelope = TransactionBuilder.fromXdr(built.build.envelopeXdr, passphrase);
      if (!(envelope instanceof Transaction)) throw new Error("fee bump");
      parsed = envelope;
    } catch {
      return blocked(contract, resolution, steps, [
        blocker(
          "exit_not_contract_invocation",
          `The ${step.kind} step for this ${protocol} position came back from ${built.build.provider} ` +
            "in a form LumenWipe could not read. Nothing was built."
        ),
      ]);
    }
    if (parsed.source !== ctx.account || parsed.operations.length !== 1) return intentMismatch;
    tx = parsed;
    const envelope = tx.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") return intentMismatch;
    op = envelope.v1.tx.operations[0]!;
  }

  const invocation = decodeInvocation(op);
  if (!invocation) {
    return blocked(contract, resolution, steps, [
      blocker(
        "exit_not_contract_invocation",
        `The ${step.kind} step for this ${protocol} position did not build as a contract ` +
          "invocation. Nothing was built."
      ),
    ]);
  }
  if (invocation.contract !== step.contract || invocation.function !== step.function) {
    return intentMismatch;
  }
  const source = operationSource(op);
  if (source !== null && source !== ctx.account) {
    return blocked(contract, resolution, steps, [
      blocker(
        "exit_op_source_mismatch",
        `The ${step.kind} step for this ${protocol} position would act for a different account ` +
          "than the one being closed. Nothing was built."
      ),
    ]);
  }

  let simulation: stellarRpc.Api.SimulateTransactionResponse;
  try {
    simulation = await deps.rpc.simulateTransaction(tx, {
      cpuInstructions: EXIT_SIMULATION_CPU_LEEWAY,
    });
  } catch {
    return blocked(contract, resolution, steps, [
      blocker(
        "exit_simulation_failed",
        `Simulating the ${step.kind} of this ${protocol} position could not reach the network. ` +
          "Nothing was built; retry the analysis."
      ),
    ]);
  }
  if (stellarRpc.Api.isSimulationError(simulation)) {
    return blocked(
      contract,
      resolution,
      steps,
      [
        blocker(
          "exit_simulation_failed",
          `Simulating the ${step.kind} of this ${protocol} position failed on the network, so ` +
            "nothing was built. The position may have changed; retry the analysis, and if it keeps " +
            "failing it needs manual review."
        ),
      ],
      true
    );
  }
  if (stellarRpc.Api.isSimulationRestore(simulation)) {
    return blocked(
      contract,
      resolution,
      steps,
      [
        blocker(
          "exit_needs_restore",
          `Part of this ${protocol} position's on-chain data has been archived and must be restored ` +
            "before it can be exited. Nothing was built; this position needs manual review."
        ),
      ],
      true
    );
  }

  let signable: Transaction;
  try {
    // A locally built operation takes its footprint, auth, and resource fee from the simulation;
    // an external envelope already carries its own and is kept byte-for-byte.
    signable =
      built.build.source === "local" ? stellarRpc.assembleTransaction(tx, simulation).build() : tx;
  } catch {
    return adapterError("assemble");
  }
  if (adapter.hardenBuilt) {
    // A protocol whose execution is known to diverge from its simulation may widen the footprint
    // and raise the fee here - and nothing else. Everything that decides what the transaction does
    // (source, sequence, bounds, memo, the operation with its arguments and authorization tree, the
    // network) must come back byte-for-byte; the fee itself is capped below.
    const before = signedShape(signable);
    let hardened: Transaction;
    try {
      hardened = adapter.hardenBuilt(signable, step, live, ctx);
    } catch {
      return adapterError("harden");
    }
    let after: string | null;
    try {
      after = signedShape(hardened);
    } catch {
      after = null;
    }
    if (
      after === null ||
      after !== before ||
      hardened.networkPassphrase !== signable.networkPassphrase
    ) {
      return intentMismatch;
    }
    signable = hardened;
  }

  // 7. What the simulation added must still be something a single-account close can sign: the
  // authorization tree may carry only the source account's own credentials - an entry for any
  // other address would need that party's signature, and would mean the call acts for someone
  // else - and the resource fee it priced must be in the range a real exit costs.
  const assembled = signable.operations[0];
  if (assembled?.type === "invokeHostFunction") {
    for (const entry of assembled.auth ?? []) {
      if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
        return blocked(
          contract,
          resolution,
          steps,
          [
            blocker(
              "exit_requires_other_signer",
              `Exiting this ${protocol} position would need authorization from another account, ` +
                "which a close cannot provide. Nothing was built; this position needs manual review."
            ),
          ],
          true
        );
      }
    }
  }
  if (BigInt(signable.fee) > BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)) {
    return blocked(
      contract,
      resolution,
      steps,
      [
        blocker(
          "exit_fee_excessive",
          `The network priced this ${protocol} exit far above what an exit normally costs, so ` +
            "nothing was built. Retry the analysis; if it keeps happening the position needs manual review."
        ),
      ],
      true
    );
  }

  return {
    contract,
    resolution,
    plan: steps,
    next: {
      ...built,
      step,
      simulation: {
        minResourceFee: simulation.minResourceFee,
        latestLedger: simulation.latestLedger,
        txXdr: signable.toXdr(),
      },
    },
    blockers: [],
  };
}
