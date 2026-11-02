import { FeeBumpTransaction, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { toHex } from "@/lib/stellar/hex";

function decode(xdr: string, passphrase: string): Transaction | FeeBumpTransaction {
  return TransactionBuilder.fromXdr(xdr, passphrase);
}

/**
 * The hash the network will give this exact envelope, on this network, computed here so that what
 * a close calls confirmed is what the user signed. Over a fee-bump it is the outer hash, which
 * commits to the inner envelope with its signatures.
 */
export function submissionHash(xdr: string, passphrase: string): string {
  return toHex(decode(xdr, passphrase).hash());
}

/** Unix seconds after which the envelope can no longer land, or null with no upper time bound. */
export function submissionValidUntil(xdr: string, passphrase: string): number | null {
  const tx = decode(xdr, passphrase);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
  return maxTime > 0 ? maxTime : null;
}

/** Whether the envelope itself removes `account`, judged on its operations, never API metadata. */
export function mergesAccount(xdr: string, passphrase: string, account: string): boolean {
  const tx = decode(xdr, passphrase);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  return intentFromXdr(inner.toXDR(), passphrase).operations.some(
    (op) => op.type === "account_merge" && op.source === account
  );
}
