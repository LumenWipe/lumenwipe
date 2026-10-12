import { Asset, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { readLiveTrustline } from "@/lib/stellar/live-trustline";
import type { ClaimableBalance, Trustline } from "@lumenwipe/types";

/**
 * The line's balance right now. "0" when the ledger confirms the line is gone; a failed read
 * throws `LiveReadError` and never falls back to the snapshot balance, which would make the
 * transfer or conversion move less than the account holds.
 */
export async function fetchLiveTrustlineBalance(
  tl: Trustline,
  accountAddress: string,
  server: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">
): Promise<string> {
  const live = await readLiveTrustline(
    server,
    accountAddress,
    new Asset(tl.code, tl.issuer),
    `The ${tl.code} balance`
  );
  return live ? stroopsToXlm(live.balance) : "0";
}

/**
 * Re-reads a batch of claimable balances over RPC and returns only those that
 * still exist on-chain. This prevents a single already-claimed balance from
 * failing the entire atomic transaction for the remaining claimants.
 */
export async function filterExistingClaimableBalances(
  balances: ClaimableBalance[],
  server: ReturnType<typeof getRpcServer>
): Promise<ClaimableBalance[]> {
  if (balances.length === 0) return [];

  const keys = balances.map((b) =>
    xdr.LedgerKey.claimableBalance(
      new xdr.LedgerKeyClaimableBalance({
        balanceId: xdr.ClaimableBalanceId.fromXDR(b.id, "hex"),
      })
    )
  );

  try {
    const res = await server.getLedgerEntries(...keys);
    const existingIds = new Set(
      (res.entries ?? []).map((e) => e.key.claimableBalance().balanceId().toXDR("hex"))
    );
    return balances.filter((b) => existingIds.has(b.id));
  } catch {
    // If the re-read fails, proceed with the full batch and let the network
    // surface per-operation errors via the standard error map.
    return balances;
  }
}
