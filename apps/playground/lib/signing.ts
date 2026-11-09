import "server-only";
import { Keypair, StrKey, hash, type Transaction } from "@stellar/stellar-sdk";
import type { SignerState } from "./horizon-submit";

// How the demolish signs a close transaction: with the demo key and the signers the session
// recorded adding, and no other key, until the weight the transaction needs is reached.

export type ThresholdCategory = "low" | "med" | "high";

type Operation = Transaction["operations"][number];

const RANK: Record<ThresholdCategory, number> = { low: 0, med: 1, high: 2 };

/**
 * stellar-core's threshold level for each operation type a playground close may contain
 * (`OperationFrame::getThresholdLevel` and its overrides), restated since apps/playground cannot
 * import the web's copy. Any other type counts as high, so it is never under-signed.
 */
const LEVELS: Readonly<Record<string, ThresholdCategory>> = {
  accountMerge: "high",
  claimClaimableBalance: "low",
  payment: "med",
  pathPaymentStrictSend: "med",
  changeTrust: "med",
  manageData: "med",
  manageSellOffer: "med",
  revokeTrustlineSponsorship: "med",
  revokeDataSponsorship: "med",
};

/** SetOptions needs the high threshold only when it touches a signer, the master weight or a
 *  threshold; otherwise medium. */
export function operationThreshold(op: Operation): ThresholdCategory {
  if (op.type === "setOptions") {
    const touchesAuth =
      op.signer !== undefined ||
      op.masterWeight !== undefined ||
      op.lowThreshold !== undefined ||
      op.medThreshold !== undefined ||
      op.highThreshold !== undefined;
    return touchesAuth ? "high" : "med";
  }
  return LEVELS[op.type] ?? "high";
}

/** The weight `tx` needs: its strictest operation against the account's live thresholds, and never
 *  less than one signature. */
export function requiredWeight(tx: Transaction, state: SignerState): number {
  const category = tx.operations.reduce<ThresholdCategory>((max, op) => {
    const c = operationThreshold(op);
    return RANK[c] > RANK[max] ? c : max;
  }, "low");
  return Math.max(1, state.thresholds[category]);
}

/** A recorded signer the playground can sign for, decrypted for one round only. */
export type SigningKey =
  | { type: "ed25519_public_key"; key: string; keypair: Keypair }
  | { type: "hash_x"; key: string; preimage: Buffer };

/** Builds a signing key from a recorded signer's decrypted secret; throws when the secret does not
 *  sign for the recorded key. */
export function signingKeyOf(type: string, key: string, secret: string): SigningKey {
  if (type === "ed25519_public_key") {
    const keypair = Keypair.fromSecret(secret);
    if (keypair.publicKey() !== key) throw new Error("A recorded co-signer's key does not match");
    return { type, key, keypair };
  }
  if (type === "hash_x") {
    const preimage = Buffer.from(secret, "hex");
    if (StrKey.encodeSha256Hash(hash(preimage)) !== key) {
      throw new Error("A recorded hash(x) preimage does not match");
    }
    return { type, key, preimage };
  }
  throw new Error("No secret signs for this signer type");
}

/**
 * Signs `tx` in place with the demo key first, then the recorded hash(x) and ed25519 signers, each
 * only if the account lists it now, and stops once `required` is reached: a signature from a key
 * that is not a signer, or more than the transaction needs, fails it as `tx_bad_auth_extra`.
 * Returns the summed live weight of what it signed with.
 */
export function signForWeight(
  tx: Transaction,
  demo: Keypair,
  keys: readonly SigningKey[],
  state: SignerState,
  required: number
): number {
  const liveWeight = (type: string, key: string): number =>
    state.signers.find((s) => s.type === type && s.key === key)?.weight ?? 0;
  let weight = 0;
  const add = (w: number, sign: () => void): void => {
    if (weight >= required || w <= 0) return;
    sign();
    weight += w;
  };
  add(liveWeight("ed25519_public_key", demo.publicKey()), () => tx.sign(demo));
  for (const k of keys) {
    if (k.type === "hash_x") add(liveWeight(k.type, k.key), () => tx.signHashX(k.preimage));
  }
  for (const k of keys) {
    if (k.type === "ed25519_public_key") add(liveWeight(k.type, k.key), () => tx.sign(k.keypair));
  }
  return weight;
}
