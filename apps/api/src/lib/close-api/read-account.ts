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
export async function readAccountState(address: string, network: Network): Promise<AccountState> {
  return getAccountState(address, network);
}
