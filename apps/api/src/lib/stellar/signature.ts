import { TransactionBuilder, Keypair, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Network } from "@/config/networks";

export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

/**
 * Offline pre-submission signature check. Catches the two most common wallet
 * mistakes before spending a network round-trip:
 *
 *  1. Wallet returned the XDR unsigned (no signatures at all).
 *  2. Wallet signed with the wrong key - hint matches the source account's
 *     last-4-byte fingerprint, but the actual signature does not verify.
 *
 * When the hint does NOT match the source account the signature is treated as
 * an unrecognized co-signer (multisig cosigner) and we defer to the network,
 * which is the authority on threshold satisfaction.
 *
 * Fee-bump envelopes are not checked here: they come only from the fee-bump sponsor endpoint
 * (`/fee-bump/sponsor`, architecture.md §8.1), whose outer signature is the sponsor account's
 * own - not a wallet's - and whose inner transaction was already validated there before the
 * sponsor ever signed it. This heuristic exists to catch wallet mistakes on a user-signed
 * inner transaction; it has nothing to check on the outer envelope of a fee-bump.
 */
export function checkTransactionSignatures(signedXdr: string, network: Network): void {
  const passphrase = NETWORK_PASSPHRASES[network];
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    // Unparseable XDR - let submit.ts propagate the real error
    return;
  }

  if (tx instanceof FeeBumpTransaction) return;

  if (tx.signatures.length === 0) {
    throw new InvalidSignatureError(
      "Transaction has no signatures. Please sign with your wallet before submitting."
    );
  }

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
    if (!sig.hint().equals(expectedHint)) {
      // Unrecognized signer - could be a multisig cosigner; let the network decide
      return;
    }
    // Hint matches the source account: verify the signature
    if (sourceKey.verify(txHash, sig.signature())) return;

    // Hint matched but signature is cryptographically invalid - wrong key or corrupted
    throw new InvalidSignatureError(
      "The transaction signature is invalid. Please reconnect your wallet and try again."
    );
  }
  // All signatures belong to unrecognized cosigners; defer to network
}
