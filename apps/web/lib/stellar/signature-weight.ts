import { hash as sha256, Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountSigner } from "@/types/account";

export interface SignerContribution {
  signer: AccountSigner;
  contributed: boolean;
}

/**
 * For each of the account's known signers, determines whether the envelope already carries a
 * valid signature from that signer. Matches by decorated-signature hint (4 bytes) then
 * cryptographically verifies against the transaction hash - a hint match alone isn't proof of
 * authenticity. ed25519 signers verify a real signature against the tx hash; hash(x) signers
 * verify the decorated signature's bytes are the exact preimage of the signer's key (the same
 * check `Transaction.signHashX` itself relies on to construct one - see HashXPreimageSigner).
 * pre-auth-tx and ed25519-signed-payload signers don't contribute a signature at all and always
 * report false, pending #102's own satisfaction path onto this same per-signer shape.
 */
export function evaluateSignatureContributions(
  xdr: string,
  networkPassphrase: string,
  signers: AccountSigner[]
): SignerContribution[] {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const txHash = tx.hash();

  return signers.map((signer) => {
    if (signer.type === "ed25519_public_key") {
      const keypair = Keypair.fromPublicKey(signer.key);
      const hint = keypair.signatureHint();
      const contributed = tx.signatures.some(
        (sig) => sig.hint().equals(hint) && keypair.verify(txHash, sig.signature())
      );
      return { signer, contributed };
    }
    if (signer.type === "hash_x") {
      const digest = StrKey.decodeSha256Hash(signer.key);
      const hint = digest.subarray(digest.length - 4);
      const contributed = tx.signatures.some(
        (sig) => sig.hint().equals(hint) && sha256(sig.signature()).equals(digest)
      );
      return { signer, contributed };
    }
    return { signer, contributed: false };
  });
}

/** Sums the weight of signers who have actually contributed a valid signature. */
export function accumulatedWeight(contributions: SignerContribution[]): number {
  return contributions.filter((c) => c.contributed).reduce((sum, c) => sum + c.signer.weight, 0);
}
