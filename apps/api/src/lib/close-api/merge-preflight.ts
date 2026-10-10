import type { AccountState } from "@lumenwipe/types";
import { getMediatorPublicKey, type Network } from "@/config/networks";
import { OP_BATCH_LIMIT } from "@/config/constants";
import { lookupExchange } from "@/lib/exchange-registry";
import { readTrustlinesOnly } from "@/lib/stellar/account-state";
import { getFeeAccountKeypair } from "@/lib/stellar/fee-account";
import { getRpcServer } from "@/lib/stellar/rpc";

export type MergePreflightProblemCode =
  | "destination_is_source"
  | "destination_is_mediator"
  | "destination_is_fee_account"
  | "destination_missing"
  | "source_sequence_too_far";

/** The API error code a problem is reported under. */
export function preflightErrorCode(
  problem: MergePreflightProblem
): "source_sequence_too_far" | "merge_destination_unusable" {
  return problem.code === "source_sequence_too_far"
    ? "source_sequence_too_far"
    : "merge_destination_unusable";
}

export interface MergePreflightProblem {
  code: MergePreflightProblemCode;
  message: string;
}

export class DestinationReadError extends Error {
  constructor(address: string) {
    super(`The destination account ${address} could not be read. Retry in a moment.`);
    this.name = "DestinationReadError";
  }
}

export class LedgerReadError extends Error {
  constructor() {
    super("The current ledger could not be read. Retry in a moment.");
    this.name = "LedgerReadError";
  }
}

export interface MergePreflightDeps {
  /** Resolves false only for a confirmed absence; throws when the read itself fails. */
  accountExists: (address: string, network: Network) => Promise<boolean>;
  latestLedger: (network: Network) => Promise<number>;
  mediator: (network: Network) => string;
  feeAccount: (network: Network) => string | null;
}

export const defaultMergePreflightDeps = (): MergePreflightDeps => ({
  accountExists: async (address, network) => (await readTrustlinesOnly(address, network)) !== null,
  latestLedger: async (network) => (await getRpcServer(network).getLatestLedger()).sequence,
  mediator: getMediatorPublicKey,
  feeAccount: (network) => getFeeAccountKeypair(network)?.publicKey() ?? null,
});

/**
 * An upper bound on the transactions the close still has to submit, the merge included.
 *
 * Every one of them raises the source's sequence number by one before the merge is judged, so
 * the headroom check must reserve this many. It is deliberately a bound, not a replay of the
 * planner: each held thing is counted at its worst case (a trustline may need a conversion and
 * a removal, a claimable balance a trustline and a claim) and each DeFi position or Soroban
 * token is counted as a transaction of its own, which over-reserves by at most a few numbers.
 */
export function remainingTransactionBound(state: AccountState, viaMediator: boolean): number {
  const classicOps =
    state.signers.length +
    state.dataEntries.length +
    state.openOffers.length +
    2 * state.trustlines.length +
    2 * state.claimableBalances.length +
    state.sponsoredEntries.length +
    1;
  const soloRounds =
    state.defiPositions.positions.length + (state.sorobanTokens?.tokens.length ?? 0);
  return Math.ceil(classicOps / OP_BATCH_LIMIT) + soloRounds + (viaMediator ? 1 : 0);
}

/** The merge is refused once the source's sequence reaches `ledger << 32`. */
export function sequenceLimit(latestLedger: number): bigint {
  return BigInt(latestLedger) << 32n;
}

function sequenceProblem(
  sequence: string,
  latestLedger: number,
  transactionCount: number
): MergePreflightProblem | null {
  if (BigInt(sequence) + BigInt(transactionCount) < sequenceLimit(latestLedger)) return null;
  return {
    code: "source_sequence_too_far",
    message:
      "This account's sequence number is too far ahead for the network to merge it. Retrying does not help: it can be closed only once the network's ledger count catches up.",
  };
}

/**
 * What would make the final merge fail, checked before any transaction is built. Without it a
 * multi-round close strips the account and only the last transaction is refused, leaving an
 * emptied account still open.
 *
 * A registry exchange is never read: it is paid through the mediator, so its own account is not
 * what the merge lands on. A failed read throws rather than reporting "missing", so a
 * provider outage is never taken for an unfunded destination.
 */
export async function assessMergePreflight(
  state: AccountState,
  destination: string | null,
  network: Network,
  deps: MergePreflightDeps = defaultMergePreflightDeps()
): Promise<MergePreflightProblem[]> {
  const problems: MergePreflightProblem[] = [];
  const viaMediator =
    destination !== null && lookupExchange(destination)?.requiresMediator === true;

  let latest: number;
  try {
    latest = await deps.latestLedger(network);
  } catch {
    throw new LedgerReadError();
  }
  const sequence = sequenceProblem(
    state.sequence,
    latest,
    remainingTransactionBound(state, viaMediator)
  );
  if (sequence) problems.push(sequence);
  if (destination === null) return problems;

  if (destination === state.address) {
    problems.push({
      code: "destination_is_source",
      message:
        "The destination is the account being closed. Choose a different account to receive the XLM.",
    });
  } else if (destination === deps.mediator(network)) {
    problems.push({
      code: "destination_is_mediator",
      message:
        "This address belongs to LumenWipe's exchange relay and cannot be used as a destination. Choose a wallet you control, or the exchange deposit address itself.",
    });
  } else if (destination === deps.feeAccount(network)) {
    problems.push({
      code: "destination_is_fee_account",
      message:
        "This address belongs to LumenWipe's fee sponsor and cannot be used as a destination. Choose a wallet you control.",
    });
  } else if (lookupExchange(destination) === null) {
    let exists: boolean;
    try {
      exists = await deps.accountExists(destination, network);
    } catch {
      throw new DestinationReadError(destination);
    }
    if (!exists) {
      problems.push({
        code: "destination_missing",
        message: `The destination account does not exist on ${network}. A close never creates it: fund the destination first, or choose a different account.`,
      });
    }
  }
  return problems;
}
