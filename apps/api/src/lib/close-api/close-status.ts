import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import type { CloseStatusResponse } from "@lumenwipe/types";
import { LiveReadError } from "@/lib/stellar/live-trustline";

/** The last operation in an account's history, or null when the provider has none for it. */
export type LastOperationReader = (source: string) => Promise<{ type: string } | null>;

const STATUS_READ_LABEL = "The account";

function sponsorshipCounts(account: xdr.AccountEntry): { sponsoring: number; sponsored: number } {
  const extension = account.ext.type === "v1" ? account.ext.v1.ext : null;
  if (extension?.type !== "v2") return { sponsoring: 0, sponsored: 0 };
  return { sponsoring: extension.v2.numSponsoring, sponsored: extension.v2.numSponsored };
}

/**
 * A close's phase, from live state alone, so nothing about a close is kept between polls. It is
 * informational: an absent account plus a merge in its history says nothing about whose merge it
 * was or which transaction did it, so no client may treat `closed` as the end of a close.
 */
export async function readCloseStatus(
  server: Pick<rpc.Server, "getLedgerEntries">,
  lastOperation: LastOperationReader,
  source: string
): Promise<CloseStatusResponse> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(source).xdrAccountId() })
  );
  const { entries } = await server.getLedgerEntries(key);
  if (!Array.isArray(entries)) throw new LiveReadError(STATUS_READ_LABEL);
  const entry = entries[0];

  if (!entry) {
    const last = await lastOperation(source);
    return { source, phase: last?.type === "account_merge" ? "closed" : "unknown" };
  }
  if (entry.val.type !== "account") throw new LiveReadError(STATUS_READ_LABEL);

  const remaining = {
    subentries: entry.val.account.numSubEntries,
    ...sponsorshipCounts(entry.val.account),
  };
  const clear = remaining.subentries + remaining.sponsoring + remaining.sponsored === 0;
  return { source, phase: clear ? "ready_to_merge" : "open", remaining };
}
