import type { AccountState, CloseTransaction, Network } from "@lumenwipe/types";
import { SLIPPAGE_BPS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import type { ExitRpc } from "./adapter";
import { exitAdapterFor } from "./catalog";
import { exitablePositions, groupExitTargets } from "./plan-exits";
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
    public readonly code: string,
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
}

export interface ExitRound {
  transaction: CloseTransaction;
  /** Steps still to come after this one: the rest of this target's plan plus every other target. */
  remainingSteps: number;
}

/**
 * Builds the next exit transaction, or null when no detected position needs one. Throws
 * `ExitRoundBlockedError` with the adapter's own code when a position cannot be exited safely -
 * the same blocker the plan showed, now refusing to build rather than to preview.
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

  const ctx = {
    network,
    account: accountState.address,
    sequence,
    tokenBalances: tokenBalancesFor(accountState),
    now: deps.now ?? new Date(),
    slippageBps: SLIPPAGE_BPS,
  };
  const run = deps.runExitAdapter ?? runExitAdapter;
  const passphrase = NETWORK_PASSPHRASES[network];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const adapter = exitAdapterFor(target.protocol);
    const exitable = exitablePositions(target);
    if (!adapter || !exitable || exitable.length === 0) {
      throw new ExitRoundBlockedError(
        "defi_exit_unsupported",
        `This account holds a ${target.protocol} position LumenWipe cannot exit yet. Close it ` +
          `through ${target.protocol} before continuing.`
      );
    }

    // Whole-position adapters (Blend) plan the entire pool from any one of its positions.
    const result: ExitRunResult = await run(adapter, exitable[0]!, ctx, { rpc: deps.rpc });

    if (result.next === null) {
      // Detection can lag the ledger by a snapshot: a position already exited on a previous
      // round may still be reported. "Gone" means nothing is left there - move on.
      const gone =
        result.blockers.length > 0 && result.blockers.every((b) => b.code === "exit_position_gone");
      if (gone) continue;
      const first = result.blockers[0];
      throw new ExitRoundBlockedError(
        first?.code ?? "defi_exit_blocked",
        first?.message ?? "This DeFi position could not be exited safely."
      );
    }

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
