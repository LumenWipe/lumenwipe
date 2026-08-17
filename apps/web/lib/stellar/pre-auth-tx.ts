import {
  FeeBumpTransaction,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

/** Thrown when a user-supplied pre-authorized transaction is malformed or its hash does not
 *  match a pre-auth-tx signer's key. Message is plain language per CLAUDE.md's user-facing-
 *  errors rule. */
export class InvalidPreAuthTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPreAuthTxError";
  }
}

/**
 * Validates a user-pasted, already-authorized transaction against a pre-auth-tx signer's key
 * before it is ever submitted. A pre-auth-tx signer's key IS `StrKey.encodePreAuthTx(hash)` of
 * the one exact transaction it authorizes - there is no signature to check, only a hash match.
 * Never returns a transaction that doesn't match - the caller must not submit one that wasn't
 * returned here.
 */
export function verifyPreAuthTxHash(
  xdr: string,
  networkPassphrase: string,
  signerKey: string
): Transaction {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new InvalidPreAuthTxError(
      "This does not look like a valid transaction. Paste the exact XDR you pre-authorized."
    );
  }

  if (tx instanceof FeeBumpTransaction) {
    throw new InvalidPreAuthTxError(
      "A fee-bump transaction cannot be used here - paste the inner transaction you pre-authorized."
    );
  }

  if (StrKey.encodePreAuthTx(tx.hash()) !== signerKey) {
    throw new InvalidPreAuthTxError(
      "This transaction's hash does not match the pre-auth-tx signer's key. Double-check you pasted the exact transaction you pre-authorized for this close."
    );
  }

  return tx;
}
