import { hash, StrKey } from "@stellar/stellar-sdk";

/** Thrown when a user-supplied hash(x) preimage is malformed or does not hash to the
 *  signer's key. Message is plain language per CLAUDE.md's user-facing-errors rule. */
export class InvalidPreimageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPreimageError";
  }
}

/**
 * Validates a hex-encoded hash(x) preimage against a hash(x) signer's key (its "X..." strkey,
 * which encodes sha256(preimage)) before it is ever handed to a signer. Never returns a
 * preimage that doesn't match - the caller must not apply one that wasn't returned here.
 * Mirrors the length bound the SDK's own `Transaction.signHashX` enforces (max 64 bytes).
 */
export function verifyHashXPreimage(preimageHex: string, signerKey: string): Buffer {
  const trimmed = preimageHex.trim();
  if (trimmed.length === 0 || !/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new InvalidPreimageError(
      "Enter the preimage as a hex-encoded value (0-9, a-f), with an even number of characters."
    );
  }

  const preimage = Buffer.from(trimmed, "hex");
  if (preimage.length > 64) {
    throw new InvalidPreimageError("The preimage is too long - it must be at most 64 bytes.");
  }

  const digest = hash(preimage);
  if (StrKey.encodeSha256Hash(digest) !== signerKey) {
    throw new InvalidPreimageError(
      "This preimage does not hash to the signer's key. Double-check what you entered."
    );
  }

  return preimage;
}
