import { summarizeTransaction } from "@/lib/stellar/intent/describe";

/**
 * The transaction a wallet is being asked to sign, as the screen shows it beside the wallet's own
 * prompt. Built from the one envelope handed to the wallet: `hash` is the hash computed from that
 * envelope after `verify()` approved it, and the summary is read from the same envelope.
 */
export interface SigningPrompt {
  /** The kit's id of the wallet asked, or null when unknown. */
  walletId: string | null;
  /** The transaction hash, hex. */
  hash: string;
  /** What the transaction does, or null when it could not be read for display. */
  summary: {
    /** Where an account merge in it sends the balance, or null without one. */
    mergeDestination: string | null;
    operationCount: number;
  } | null;
}

/**
 * `approvedHash` must be the hash of `xdr`, the envelope about to be signed: the caller computes
 * it once from that envelope and uses it to check the signed result too. A summary that cannot be
 * read never stops signing; the screen then shows the hash alone.
 */
export function signingPromptFor(
  walletId: string | null,
  xdr: string,
  passphrase: string,
  approvedHash: string
): SigningPrompt {
  let summary: SigningPrompt["summary"] = null;
  try {
    const read = summarizeTransaction(xdr, passphrase);
    summary = { mergeDestination: read.mergeDestination, operationCount: read.operations.length };
  } catch {
    summary = null;
  }
  return { walletId, hash: approvedHash, summary };
}

/** The first and last eight characters of a hash, to compare with what a wallet shows. */
export function hashFingerprint(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}
