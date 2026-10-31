import type { AccountState } from "@lumenwipe/types";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { readLiveLedger, type LiveLedger } from "@/lib/stellar/live-ledger";
import { AccountStateChangedError } from "@/lib/utils/errors";

/**
 * The first way the ledger disagrees with the enumerated `state`, or null when it agrees. Pure:
 * the comparison is against the state this same round enumerated, so a change an earlier round
 * made is already in `state` and never reads as drift.
 */
export function findStateDrift(state: AccountState, live: LiveLedger): string | null {
  const { account } = live;
  if (!account) return "account no longer exists";
  if (account.sequence !== state.sequence) {
    return `sequence ${state.sequence} enumerated, ${account.sequence} on the ledger`;
  }
  if (account.numSubEntries !== state.numSubEntries) {
    return `${state.numSubEntries} sub-entries enumerated, ${account.numSubEntries} on the ledger`;
  }
  return null;
}

/**
 * Confirms the enumerated state against the ledger over RPC and returns the sequence to build on.
 * Throws `AccountStateChangedError` on any disagreement and `LiveReadError` when the read fails.
 */
export async function confirmLedgerState(
  state: AccountState,
  server: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">
): Promise<string> {
  const live = await readLiveLedger(server, state);
  const drift = findStateDrift(state, live);
  if (drift !== null) throw new AccountStateChangedError(drift);
  return state.sequence;
}
