import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountSigner } from "@/types/account";

export interface SignerContribution {
  signer: AccountSigner;
  contributed: boolean;
}

/**
 * For each of the account's known signers, determines whether the envelope already carries a
 * valid signature from that signer. Matches by decorated-signature hint (4 bytes) then
 * cryptographically verifies against the transaction hash - a hint match alone isn't proof of
 * authenticity. Only ed25519 signers are checked here: hash(x) preimages and pre-auth-tx don't
 * contribute a signature at all, so they always report false until #101/#102 add their own
 * satisfaction paths onto this same per-signer shape.
 */
export function evaluateSignatureContributions(
  xdr: string,
  networkPassphrase: string,
  signers: AccountSigner[]
): SignerContribution[] {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const hash = tx.hash();

  return signers.map((signer) => {
    if (signer.type !== "ed25519_public_key") {
      return { signer, contributed: false };
    }
    const keypair = Keypair.fromPublicKey(signer.key);
    const hint = keypair.signatureHint();
    const contributed = tx.signatures.some(
      (sig) => sig.hint().equals(hint) && keypair.verify(hash, sig.signature())
    );
    return { signer, contributed };
  });
}

/** Sums the weight of signers who have actually contributed a valid signature. */
export function accumulatedWeight(contributions: SignerContribution[]): number {
  return contributions.filter((c) => c.contributed).reduce((sum, c) => sum + c.signer.weight, 0);
}
