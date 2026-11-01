import { StrKey } from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { evaluateSignatureContributions } from "@/lib/stellar/signature-weight";
import { UserFacingError } from "@/lib/utils/user-error";

function isHashXKey(key: string): boolean {
  try {
    StrKey.decodeSha256Hash(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hash(x) signature is the preimage itself: it is not bound to a transaction, and the signer
 * stays on the account after it is used. So anyone who reads the preimage off the ledger holds
 * that signer's weight until the signer is removed, and the only safe transaction to carry it is
 * one that removes that same signer. Judged on the envelope, never on API metadata.
 */
export function assertPreimageRemovesItsSigner(
  xdr: string,
  networkPassphrase: string,
  account: string,
  signerKey: string
): void {
  if (!isHashXKey(signerKey)) return;
  const removed = intentFromXdr(xdr, networkPassphrase).operations.some(
    (op) =>
      op.type === "set_options" &&
      op.source === account &&
      op.signer?.key === signerKey &&
      op.signer.type === "hash_x" &&
      op.signer.weight === 0
  );
  if (removed) return;
  throw new UserFacingError(
    "Nothing was signed or sent. This preimage can't be used for this step: the step doesn't remove its signer, so the preimage would stay valid on the account once it is published. This step needs another signer."
  );
}

/**
 * Normalization leaves the master key as the account's only signer. Without the merge in the same
 * transaction, the account must still be usable by that key afterwards: the master key has signed,
 * or nothing the user holds could act on the account again, and the same envelope lowers every
 * threshold to 1 or below, or the master key alone could not reach them. Only the envelope proves
 * either, and the key comes from the user's own account address, not from an API read.
 */
export function assertMasterSignsSignerRemoval(
  xdr: string,
  networkPassphrase: string,
  account: string
): void {
  const { operations } = intentFromXdr(xdr, networkPassphrase);
  const removesSigner = operations.some(
    (op) => op.type === "set_options" && op.signer?.weight === 0
  );
  const merges = operations.some((op) => op.type === "account_merge" && op.source === account);
  if (!removesSigner || merges) return;
  const resetsThresholds = operations.some(
    (op) =>
      op.type === "set_options" &&
      op.source === account &&
      op.lowThreshold !== null &&
      op.lowThreshold <= 1 &&
      op.medThreshold !== null &&
      op.medThreshold <= 1 &&
      op.highThreshold !== null &&
      op.highThreshold <= 1
  );
  if (!resetsThresholds) {
    throw new UserFacingError(
      "Nothing was submitted and your funds stay where they are. This step removes signers without resetting the account's thresholds, so the master key alone could not act on the account afterwards."
    );
  }
  const [master] = evaluateSignatureContributions(xdr, networkPassphrase, [
    { key: account, weight: 1, type: "ed25519_public_key" },
  ]);
  if (master?.contributed) return;
  throw new UserFacingError(
    "Nothing was submitted and your funds stay where they are. This step must include the account's master key, because the other signers are removed before the merge."
  );
}
