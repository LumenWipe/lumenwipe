import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import { getAccountState } from "@/lib/stellar/account";
import { getLiveAccountState } from "@/lib/stellar/account-live";
import { needsLiveRescan } from "@/lib/stellar/scan-fallback";

// Reads account state for the close API, mirroring the read-only account route:
// stellar.expert lags for freshly created accounts and never returns manage-data
// entries, so on any mismatch fall back to the Horizon-based live scan, which has
// zero indexing lag and full enumeration. The blocker only stands if the live scan
// confirms it. Never build a plan or transaction from indexer data that the live
// scan contradicts.
export async function readAccountState(address: string, network: Network): Promise<AccountState> {
  let state = await getAccountState(address, network);
  if (needsLiveRescan(state)) {
    try {
      state = await getLiveAccountState(address, network);
    } catch {
      // Keep the stellar.expert result if the live path also fails.
    }
  }
  return state;
}
