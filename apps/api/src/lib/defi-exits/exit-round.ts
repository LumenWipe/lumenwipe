import type { ErrorCode } from "@lumenwipe/types";
import { isErrorCode } from "@/common/error-codes";
import type { AccountState, CloseTransaction, Network } from "@lumenwipe/types";
import { SLIPPAGE_BPS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { EXIT_POSITION_GONE, type ExitContext, type ExitRpc } from "./adapter";
import { exitAdapterFor } from "./catalog";
import {
  exitablePositions,
  groupExitTargets,
  type ExitTarget,
  type ExitTargetBlock,
} from "./plan-exits";
import { runExitAdapter, type ExitRunResult } from "./run-exit";
import { tokenBalancesFor } from "./token-balances";

/**
 * The exit round of a close: before any classic cleanup, every DeFi position leaves its protocol
 * one transaction at a time. A Soroban invocation cannot share a transaction with classic
 * operations, and each step depends on the one before it (a withdraw after a repay), so the
 * round builds exactly one step - the first executable one, simulated against the current
 * ledger - and asks the client to call again once it confirms. The next call re-detects
 * positions from live state, so the plan is always re-derived, never pre-built stale.
 */

export class ExitRoundBlockedError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExitRoundBlockedError";
  }
}

export interface ExitRoundDeps {
  rpc: ExitRpc;
  now?: Date;
  /** Overridable so tests can drive the round with a stand-in runner. */
  runExitAdapter?: typeof runExitAdapter;
  /** Exit targets (by contract) the user explicitly chose to leave behind. Honoured only while
   *  the target's exit cannot be built for a reason that makes it leave-eligible: an exit that
   *  builds is always offered, and a transient or fixable blocker still refuses the round. */
  leaveBehind?: ReadonlySet<string>;
}

export interface ExitRound {
  transaction: CloseTransaction;
  /** Steps still to come after this one: the rest of this target's plan plus every other target. */
  remainingSteps: number;
}

type TargetOutcome =
  | { kind: "exitable"; result: ExitRunResult & { next: NonNullable<ExitRunResult["next"]> } }
  | { kind: "gone" }
  | ({ kind: "blocked" } & ExitTargetBlock);

function unsupportedBlock(target: ExitTarget): ExitTargetBlock {
  return {
    code: "defi_exit_unsupported",
    message:
      `This account holds a ${target.protocol} position LumenWipe cannot exit yet. Close it ` +
      `through ${target.protocol} before continuing.`,
    leaveEligible: true,
  };
}

async function assessTarget(
  target: ExitTarget,
  ctx: ExitContext,
  run: typeof runExitAdapter,
  rpc: ExitRpc
): Promise<TargetOutcome> {
  const adapter = exitAdapterFor(target.protocol);
  const exitable = exitablePositions(target);
  if (!adapter || !exitable || exitable.length < target.positions.length) {
    return { kind: "blocked", ...unsupportedBlock(target) };
  }
  // Whole-position adapters (Blend) plan the entire pool from any one of its positions.
  const result = await run(adapter, exitable[0]!, ctx, { rpc });
  if (result.next !== null) return { kind: "exitable", result: { ...result, next: result.next } };
  // Detection can lag the ledger by a snapshot: a position already exited on a previous round may
  // still be reported. "Gone" means nothing is left there - move on.
  const gone =
    result.blockers.length > 0 && result.blockers.every((b) => b.code === EXIT_POSITION_GONE);
  if (gone) return { kind: "gone" };
  const first = result.blockers[0];
  return {
    kind: "blocked",
    code: first?.code ?? "defi_exit_blocked",
    message: first?.message ?? "This DeFi position could not be exited safely.",
    leaveEligible: result.leaveEligible === true && result.blockers.length > 0,
  };
}

function exitContext(
  accountState: AccountState,
  network: Network,
  sequence: string,
  now?: Date
): ExitContext {
  return {
    network,
    account: accountState.address,
    sequence,
    tokenBalances: tokenBalancesFor(accountState),
    now: now ?? new Date(),
    slippageBps: SLIPPAGE_BPS,
  };
}

/**
 * Builds the next exit transaction, or null when no detected position needs one. Throws
 * `ExitRoundBlockedError` with the adapter's own code when a position cannot be exited safely -
 * the same blocker the plan showed, now refusing to build rather than to preview - unless the
 * user chose to leave that target behind and its blocker allows it.
 */
export async function buildExitRound(
  accountState: AccountState,
  network: Network,
  sequence: string,
  validUntilLedger: number,
  deps: ExitRoundDeps
): Promise<ExitRound | null> {
  const targets = groupExitTargets(accountState.defiPositions.positions);
  if (targets.length === 0) return null;

  const ctx = exitContext(accountState, network, sequence, deps.now);
  const run = deps.runExitAdapter ?? runExitAdapter;
  const passphrase = NETWORK_PASSPHRASES[network];
  const leaveBehind = deps.leaveBehind ?? new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const outcome = await assessTarget(target, ctx, run, deps.rpc);
    if (outcome.kind === "gone") continue;
    if (outcome.kind === "blocked") {
      if (outcome.leaveEligible && leaveBehind.has(target.contract)) continue;
      throw new ExitRoundBlockedError(
        isErrorCode(outcome.code) ? outcome.code : "defi_exit_blocked",
        outcome.leaveEligible
          ? `${outcome.message} Analyze the account again to choose whether to leave it behind.`
          : outcome.message
      );
    }

    const { result } = outcome;
    const xdr = result.next.simulation.txXdr;
    const remainingTargets = targets.length - i - 1;
    return {
      transaction: {
        id: "tx-1",
        order: 0,
        dependsOn: [],
        xdr,
        networkPassphrase: passphrase,
        sourceSequence: sequence,
        validUntilLedger,
        covers: ["EXIT_POSITIONS"],
        // One exit target per transaction: a Soroban call cannot share one. Naming it lets the
        // client mark this exit and no other.
        coversTargets: [target.contract],
        intent: {
          ...intentFromXdr(xdr, passphrase),
          summary: result.next.step.description,
        },
      },
      remainingSteps: result.plan.length - 1 + remainingTargets,
    };
  }
  return null;
}

/**
 * The plan's view of the exit round: runs every target the way the round would, against the
 * account read the plan uses, and reports the ones whose exit cannot be built right now. Nothing
 * here is offered for signing; the round re-runs every check against live state before it builds.
 */
export async function preflightExitTargets(
  accountState: AccountState,
  network: Network,
  deps: Pick<ExitRoundDeps, "rpc" | "now" | "runExitAdapter">
): Promise<Map<string, ExitTargetBlock>> {
  const blocked = new Map<string, ExitTargetBlock>();
  const targets = groupExitTargets(accountState.defiPositions.positions);
  if (targets.length === 0) return blocked;
  const ctx = exitContext(accountState, network, accountState.sequence, deps.now);
  const run = deps.runExitAdapter ?? runExitAdapter;
  const outcomes = await Promise.all(targets.map((t) => assessTarget(t, ctx, run, deps.rpc)));
  outcomes.forEach((outcome, i) => {
    if (outcome.kind === "blocked") {
      const { code, message, leaveEligible } = outcome;
      blocked.set(targets[i]!.contract, { code, message, leaveEligible });
    }
  });
  return blocked;
}
