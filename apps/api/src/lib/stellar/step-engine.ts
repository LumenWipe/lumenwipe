import { Asset, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { LiveReadError, readLiveTrustline } from "@/lib/stellar/live-trustline";
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
 * failing the entire atomic transaction for the remaining claimants. A failed
 * read throws `LiveReadError` rather than assuming every balance still exists.
 */
export async function filterExistingClaimableBalances(
  balances: ClaimableBalance[],
  server: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">
): Promise<ClaimableBalance[]> {
  if (balances.length === 0) return [];

  const keys = balances.map((b) =>
    xdr.LedgerKey.claimableBalance(
      new xdr.LedgerKeyClaimableBalance({
        balanceId: xdr.ClaimableBalanceId.fromXdr(b.id, "hex"),
      })
    )
  );

  let entries: Awaited<ReturnType<typeof server.getLedgerEntries>>["entries"];
  try {
    entries = (await server.getLedgerEntries(...keys)).entries;
  } catch {
    throw new LiveReadError("The claimable balances");
  }
  if (!Array.isArray(entries)) throw new LiveReadError("The claimable balances");
  const existingIds = new Set(
    entries.flatMap((e) =>
      e.key.type === "claimableBalance" ? [e.key.claimableBalance.balanceId.toXdr("hex")] : []
    )
  );
  return balances.filter((b) => existingIds.has(b.id));
}
