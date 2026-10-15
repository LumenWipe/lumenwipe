import { hash as sha256, Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { IntentOperation } from "@/types/close-api";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

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
  const tx = TransactionBuilder.fromXdr(xdr, networkPassphrase);
  const txHash = tx.hash();

  return signers.map((signer) => {
    if (signer.type === "ed25519_public_key") {
      const keypair = Keypair.fromPublicKey(signer.key);
      const hint = keypair.signatureHint();
      const contributed = tx.signatures.some(
        (sig) =>
          bytesEqual(sig.hint.toBytes(), hint) && keypair.verify(txHash, sig.signature.toBytes())
      );
      return { signer, contributed };
    }
    if (signer.type === "hash_x") {
      const digest = StrKey.decodeSha256Hash(signer.key);
      const hint = digest.subarray(digest.length - 4);
      const contributed = tx.signatures.some(
        (sig) =>
          bytesEqual(sig.hint.toBytes(), hint) &&
          bytesEqual(sha256(sig.signature.toBytes()), digest)
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

/** The signers and thresholds a round's signing weight is judged against. */
export interface SignerState {
  signers: AccountSigner[];
  thresholds: AccountThresholds;
}

function isThreshold(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
}

function decodes(decode: () => unknown): boolean {
  try {
    decode();
    return true;
  } catch {
    return false;
  }
}

const SIGNER_KEY_IS_VALID: Record<AccountSigner["type"], (key: string) => boolean> = {
  ed25519_public_key: (key) => StrKey.isValidEd25519PublicKey(key),
  hash_x: (key) => decodes(() => StrKey.decodeSha256Hash(key)),
  preauth_tx: (key) => decodes(() => StrKey.decodePreAuthTx(key)),
  ed25519_signed_payload: (key) => StrKey.isValidSignedPayload(key),
};

function isSigner(s: unknown): s is AccountSigner {
  if (typeof s !== "object" || s === null) return false;
  const c = s as Record<string, unknown>;
  if (typeof c.key !== "string" || !isThreshold(c.weight) || typeof c.type !== "string") {
    return false;
  }
  const valid = SIGNER_KEY_IS_VALID[c.type as AccountSigner["type"]];
  return Object.hasOwn(SIGNER_KEY_IS_VALID, c.type) && valid(c.key);
}

/** The round's own signer state when the response carries a well-formed one, otherwise null. */
export function parseRoundSignerState(value: unknown): SignerState | null {
  if (typeof value !== "object" || value === null) return null;
  const { signers, thresholds } = value as Record<string, unknown>;
  if (!Array.isArray(signers) || !signers.every(isSigner)) return null;
  if (new Set(signers.map((s) => s.key)).size !== signers.length) return null;
  if (typeof thresholds !== "object" || thresholds === null) return null;
  const t = thresholds as Record<string, unknown>;
  if (!isThreshold(t.low) || !isThreshold(t.med) || !isThreshold(t.high)) return null;
  return {
    signers: signers.map((s) => ({ key: s.key, weight: s.weight, type: s.type })),
    thresholds: { low: t.low, med: t.med, high: t.high },
  };
}

function withSigner(signers: AccountSigner[], signer: AccountSigner): AccountSigner[] {
  const rest = signers.filter((s) => s.key !== signer.key);
  return signer.weight === 0 ? rest : [...rest, signer];
}

/**
 * The signer state after a confirmed transaction: each `SetOptions` it carried for the account
 * applied in order, as the ledger applied them. Later transactions in the same round are signed
 * against this, since the round's own read predates them.
 */
export function applyConfirmedSetOptions(
  state: SignerState,
  operations: IntentOperation[],
  account: string
): SignerState {
  let { signers, thresholds } = state;
  for (const op of operations) {
    if (op.type !== "set_options" || op.source !== account) continue;
    if (op.signer) signers = withSigner(signers, op.signer);
    if (op.masterWeight !== null) {
      signers = withSigner(signers, {
        key: account,
        weight: op.masterWeight,
        type: "ed25519_public_key",
      });
    }
    thresholds = {
      low: op.lowThreshold ?? thresholds.low,
      med: op.medThreshold ?? thresholds.med,
      high: op.highThreshold ?? thresholds.high,
    };
  }
  return { signers, thresholds };
}

/** The signer state once a transaction has applied: its `SetOptions` for the account, and the
 *  pre-authorized-transaction signer it matched, which the ledger removes when it applies. */
export function applyConfirmedTransaction(
  state: SignerState,
  xdr: string,
  networkPassphrase: string,
  operations: IntentOperation[],
  account: string
): SignerState {
  const consumed = StrKey.encodePreAuthTx(
    TransactionBuilder.fromXdr(xdr, networkPassphrase).hash()
  );
  const next = applyConfirmedSetOptions(state, operations, account);
  return { ...next, signers: next.signers.filter((s) => s.key !== consumed) };
}
