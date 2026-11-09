import { Keypair, FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";

export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

/**
 * Offline pre-submission signature check for `POST /close/submit`, its only caller. It catches one
 * wallet mistake before spending a network round-trip: a signature whose hint matches the source
 * account's last-4-byte fingerprint but that does not verify (wrong key, or a corrupted signature).
 *
 * An envelope with no signatures is not refused here. A transaction can be fully authorized with
 * none: a pre-authorized transaction (signer key `preAuthTx`) is authorized by its own hash, which
 * is the documented "paste the exact pre-authorized transaction" flow. The network is the authority
 * on whether the signing weight is met, and an envelope short of it comes back as `tx_bad_auth`.
 *
 * When the hint does NOT match the source account the signature is treated as an unrecognized
 * co-signer (multisig cosigner) and we defer to the network, for the same reason.
 *
 * This is a UX shortcut on a relay, not an authorization gate: anything `/close/submit` accepts
 * could be sent to the network directly. Never reuse it to decide whether the service signs,
 * sponsors or co-signs anything; those paths need their own checks.
 *
 * Fee-bump envelopes are not checked here: they come only from the fee-bump sponsor endpoint
 * (`/fee-bump/sponsor`, architecture.md §8.1), whose outer signature is the sponsor account's
 * own - not a wallet's - and whose inner transaction was already validated there before the
 * sponsor ever signed it. This heuristic exists to catch wallet mistakes on a user-signed
 * inner transaction; it has nothing to check on the outer envelope of a fee-bump.
 */
export function checkTransactionSignatures(tx: Transaction | FeeBumpTransaction): void {
  if (tx instanceof FeeBumpTransaction) return;

  let sourceKey: Keypair;
  try {
    sourceKey = Keypair.fromPublicKey(tx.source);
  } catch {
    // Muxed or unrecognised address format - skip offline check
    return;
  }

  const expectedHint = sourceKey.rawPublicKey().slice(-4);
  const txHash = tx.hash();

  for (const sig of tx.signatures) {
    const hint = sig.hint.toBytes();
    if (hint.length !== expectedHint.length || hint.some((b, i) => b !== expectedHint[i])) {
      // Unrecognized signer - could be a multisig cosigner; let the network decide
      return;
    }
    // Hint matches the source account: verify the signature
    if (sourceKey.verify(txHash, sig.signature)) return;

    // Hint matched but signature is cryptographically invalid - wrong key or corrupted
    throw new InvalidSignatureError(
      "The transaction signature is invalid. Please reconnect your wallet and try again."
    );
  }
  // No signatures, or all of them from unrecognized cosigners; defer to the network
}
