import type { Network } from "@/config/networks";
import type { AccountState } from "@lumenwipe/types";
import { getAccountState } from "@/lib/stellar/account-state";

// Reads account state for the close API from the single Horizon-compatible provider.
//
// This used to be a two-step dance: an indexer-backed read first, then a re-read through a
// zero-lag path whenever the first one came up short. That existed because the indexer lagged
// for freshly created accounts and never returned manage-data entries at all. With one
// zero-lag provider there is nothing to re-check against, so a sub-entry mismatch is now the
// answer rather than a prompt to look again - and it reaches the plan builder as a blocker.
//
// Soroban token discovery runs in its quick form here: the analysis already scanned recent events
// to find what the account holds, and a close re-reads state on every round, so the rounds only
// re-confirm balances (explorer, lists, positions, and the contracts the caller names) within a
// budget that keeps a multi-round close moving.
export const CLOSE_ROUND_TOKENS_BUDGET_MS = 8_000;

export async function readAccountState(
  address: string,
  network: Network,
  manualTokenCandidates: string[] = []
): Promise<AccountState> {
  return getAccountState(address, network, {
    manualTokenCandidates,
    sorobanTokensBudgetMs: CLOSE_ROUND_TOKENS_BUDGET_MS,
    scanTokenEvents: false,
  });
}
