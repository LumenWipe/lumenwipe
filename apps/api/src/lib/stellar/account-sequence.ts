import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { LiveReadError } from "@/lib/stellar/live-trustline";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

/** The account's current sequence number, or null when the ledger confirms it does not exist. */
export async function readAccountSequence(
  server: LedgerReader,
  account: string
): Promise<bigint | null> {
  const label = "The account to sponsor";
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() })
  );
  let entries: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>["entries"];
  try {
    entries = (await server.getLedgerEntries(key)).entries;
  } catch {
    throw new LiveReadError(label);
  }
  if (!Array.isArray(entries)) throw new LiveReadError(label);
  const entry = entries[0];
  if (!entry) return null;
  if (entry.val.type !== "account") throw new LiveReadError(label);
  return BigInt(entry.val.account.seqNum);
}
