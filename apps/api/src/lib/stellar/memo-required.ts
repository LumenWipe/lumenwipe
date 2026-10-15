import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { LiveReadError } from "@/lib/stellar/live-trustline";

/** SEP-29: an account that sets this data entry to "1" asks every sender to attach a memo. */
export const MEMO_REQUIRED_DATA_NAME = "config.memo_required";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

/**
 * Whether the account's own ledger state says payments to it need a memo. An account that does
 * not exist has no data entries and so requires none; a read that fails is never read as "no".
 */
export async function readMemoRequired(server: LedgerReader, account: string): Promise<boolean> {
  const label = "The destination's memo requirement";
  const key = xdr.LedgerKey.data(
    new xdr.LedgerKeyData({
      accountId: Keypair.fromPublicKey(account).xdrAccountId(),
      dataName: MEMO_REQUIRED_DATA_NAME,
    })
  );
  let entries: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>["entries"];
  try {
    entries = (await server.getLedgerEntries(key)).entries;
  } catch {
    throw new LiveReadError(label);
  }
  if (!Array.isArray(entries)) throw new LiveReadError(label);
  const entry = entries[0];
  if (!entry) return false;
  if (entry.val.type !== "data") throw new LiveReadError(label);
  return Buffer.from(entry.val.data.dataValue.value).toString("utf8") === "1";
}
