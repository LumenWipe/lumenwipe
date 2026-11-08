import { Keypair, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { PendingRound } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import { serializeCosignArtifact, type CosignArtifact } from "@/lib/cosign/artifact";
import { assertSignerNormalization, IMPORT_FLOOR_SECONDS } from "@/lib/cosign/station-checks";
import { fromHex, toHex } from "@/lib/stellar/hex";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { requiredSignatureWeight } from "@/lib/stellar/thresholds";
import { UserFacingError } from "@/lib/utils/user-error";
import type { AccountSigner, AccountThresholds } from "@/types/account";

/**
 * The hub's half of cross-device cosigning (docs/multisig-cosigning.md Sections 4 and 7.3): the
 * request it exports, the signatures it takes from a response, and the set it attaches. Only
 * signatures are ever taken from a response, never its transaction body.
 */

/** A signature that verified over the round's pinned hash for exactly one ed25519 signer. */
export interface PoolSignature {
  key: string;
  weight: number;
  signature: xdr.DecoratedSignature;
}

export const COSIGN_REFUSED = {
  otherAccount: "This response is for another account or network.",
  otherRound:
    "This response is for another transaction. Ask the cosigner to sign the current request.",
  unknownKey:
    "This response carries a signature that is not from one of this account's signers, so none of it was used.",
  duplicate: "This response repeats a signature that is already collected, so none of it was used.",
  tooMany: "This step cannot carry that many signatures.",
  impossible:
    "These signatures cannot be combined: with the master key's signature required on this step, one of them would go unused, which the network refuses. Rebuild the step and collect signatures from cosigners whose keys reach the signing weight with the master key only when all of them sign. If no set of this account's keys does that, the account cannot be closed this way.",
  signersChanged: "This account's signers changed since this step was built. Rebuild the step.",
} as const;

export const COSIGN_UNAVAILABLE = {
  notPinned: "This step was not checked in a way another device can rely on.",
  notNormalization: "Only the step that removes the other signers can be signed on another device.",
  noMaster: "Sign this step with the master key here first, then export it.",
  expiring: "This step expires too soon to be signed on another device. Rebuild it.",
} as const;

const MAX_SIGNATURES = 20;

function refuse(message: string): never {
  throw new UserFacingError(message);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The envelope of `envelopeXdr`'s own transaction carrying exactly `signatures`. */
export function envelopeWith(envelopeXdr: string, signatures: xdr.DecoratedSignature[]): string {
  const decoded = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  if (decoded.type !== "envelopeTypeTx") throw new TypeError("not a plain transaction envelope");
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: decoded.v1.tx, signatures })
  ).toXDR("base64");
}

/**
 * Maps each signature of `tx` to the one ed25519 signer with weight that its hint names, and
 * verifies it over `hash`. Returns null when any signature names no such signer, names more than
 * one, or does not verify: a set holding such a signature is never used.
 */
function mapSignatures(
  tx: Transaction,
  hash: Uint8Array,
  signers: AccountSigner[]
): PoolSignature[] | null {
  const candidates = signers.filter((s) => s.type === "ed25519_public_key" && s.weight > 0);
  const mapped: PoolSignature[] = [];
  for (const signature of tx.signatures) {
    const hint = signature.hint.toBytes();
    const named = candidates.filter((s) =>
      bytesEqual(Keypair.fromPublicKey(s.key).signatureHint(), hint)
    );
    if (named.length !== 1) return null;
    const signer = named[0]!;
    if (!Keypair.fromPublicKey(signer.key).verify(hash, signature.signature.toBytes())) {
      return null;
    }
    mapped.push({ key: signer.key, weight: signer.weight, signature });
  }
  return mapped;
}

export type CosignExport =
  | { available: true; request: string; hash: string; maxTime: number }
  | { available: false; reason: string };

/**
 * The request for a paused round, when another device may sign it: the round was pinned at
 * verify time, it is the signer normalization the station accepts (the same rule), the master
 * key's signature is already on it, and enough time is left for the station to accept it.
 */
export function cosignExport(input: {
  round: PendingRound;
  network: Network;
  account: string;
  signers: AccountSigner[];
  passphrase: string;
  nowSeconds: number;
}): CosignExport {
  const { round, network, account, signers, passphrase, nowSeconds } = input;
  if (round.approvedHash === undefined) {
    return { available: false, reason: COSIGN_UNAVAILABLE.notPinned };
  }
  const tx = TransactionBuilder.fromXdr(round.xdr, passphrase) as Transaction;
  if (toHex(tx.hash()) !== round.approvedHash) {
    return { available: false, reason: COSIGN_UNAVAILABLE.notPinned };
  }
  const intent = intentFromXdr(round.xdr, passphrase);
  try {
    assertSignerNormalization(intent.operations, account, signers, intent.fee);
  } catch {
    return { available: false, reason: COSIGN_UNAVAILABLE.notNormalization };
  }
  const own = mapSignatures(tx, tx.hash(), signers);
  if (!own?.some((s) => s.key === account)) {
    return { available: false, reason: COSIGN_UNAVAILABLE.noMaster };
  }
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime - nowSeconds < IMPORT_FLOOR_SECONDS) {
    return { available: false, reason: COSIGN_UNAVAILABLE.expiring };
  }
  const request = serializeCosignArtifact({
    direction: "request",
    network,
    account,
    envelope: envelopeWith(round.xdr, []),
  });
  return { available: true, request, hash: round.approvedHash, maxTime };
}

/** The verified signatures already on the round's own envelope. */
export function roundSignatures(
  round: PendingRound,
  signers: AccountSigner[],
  passphrase: string
): PoolSignature[] {
  const tx = TransactionBuilder.fromXdr(round.xdr, passphrase) as Transaction;
  return mapSignatures(tx, tx.hash(), signers) ?? [];
}

/**
 * The signatures a response adds (check 7.3a to 7.3e). The transaction it carries must hash, on
 * this device's network, to the hash pinned when the round was verified. Each of its signatures
 * must verify over that hash for exactly one ed25519 signer of the round, once, and for a key not
 * already collected. One signature that fails any of this refuses the whole response.
 */
export function verifyResponse(input: {
  artifact: CosignArtifact;
  round: PendingRound;
  network: Network;
  account: string;
  signers: AccountSigner[];
  passphrase: string;
  pool: PoolSignature[];
}): PoolSignature[] {
  const { artifact, round, network, account, signers, passphrase, pool } = input;
  if (artifact.direction !== "response" || artifact.network !== network) {
    refuse(COSIGN_REFUSED.otherAccount);
  }
  if (artifact.account !== account) refuse(COSIGN_REFUSED.otherAccount);
  if (round.approvedHash === undefined) refuse(COSIGN_REFUSED.otherRound);
  const tx = TransactionBuilder.fromXdr(artifact.envelope, passphrase) as Transaction;
  if (toHex(tx.hash()) !== round.approvedHash) refuse(COSIGN_REFUSED.otherRound);
  const added = mapSignatures(tx, fromHex(round.approvedHash), signers);
  if (added === null || added.length === 0) refuse(COSIGN_REFUSED.unknownKey);
  const keys = new Set(pool.map((s) => s.key));
  for (const signature of added) {
    if (keys.has(signature.key)) refuse(COSIGN_REFUSED.duplicate);
    keys.add(signature.key);
  }
  return added;
}

const weightOf = (set: readonly PoolSignature[]): number =>
  set.reduce((sum, s) => sum + s.weight, 0);

/** No signature of `set` can go unused, whatever order the network counts them in: without any
 *  one of them the weight falls short. */
function everySignatureNeeded(set: readonly PoolSignature[], required: number): boolean {
  const total = weightOf(set);
  return total >= required && set.every((s) => total - s.weight < required);
}

function* combinations<T>(items: readonly T[], size: number, from = 0): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = from; i <= items.length - size; i++) {
    for (const rest of combinations(items, size - 1, i + 1)) yield [items[i]!, ...rest];
  }
}

/**
 * The set to attach (check 7.3f): it holds every `mandatory` key, meets `required`, and no
 * signature of it can be removed while still meeting it, so none can go unused in any counting
 * order. The smallest such set is taken, then the lightest. Null while the pool cannot meet the
 * weight with the mandatory keys; refused when it can, but only with a signature to spare.
 */
export function minimalSignatureSet(
  pool: readonly PoolSignature[],
  required: number,
  mandatory: readonly string[]
): PoolSignature[] | null {
  const must = pool.filter((s) => mandatory.includes(s.key));
  if (must.length !== mandatory.length || weightOf(pool) < required) return null;
  // An envelope holds at most 20 signatures and an account at most 20 signers, so this search
  // over subsets stays bounded.
  const rest = pool
    .filter((s) => !mandatory.includes(s.key))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  for (let size = 0; size <= rest.length; size++) {
    let best: PoolSignature[] | null = null;
    for (const combination of combinations(rest, size)) {
      const set = [...must, ...combination];
      if (!everySignatureNeeded(set, required)) continue;
      if (best === null || weightOf(set) < weightOf(best)) best = set;
    }
    if (best !== null) {
      if (best.length > MAX_SIGNATURES) refuse(COSIGN_REFUSED.tooMany);
      return best;
    }
  }
  refuse(COSIGN_REFUSED.impossible);
}

/**
 * Check 7.3h, right before the cosigned round is prepared: against the account read live now, the
 * transaction is still on its next sequence number, still removes exactly the other signers, and
 * the signatures attached all count and are all needed.
 */
export function assertStillSignable(input: {
  envelopeXdr: string;
  passphrase: string;
  account: string;
  live: { sequence: string; signers: AccountSigner[]; thresholds: AccountThresholds };
}): void {
  const { envelopeXdr, passphrase, account, live } = input;
  const tx = TransactionBuilder.fromXdr(envelopeXdr, passphrase) as Transaction;
  if (BigInt(tx.sequence) !== BigInt(live.sequence) + BigInt(1)) {
    refuse(COSIGN_REFUSED.signersChanged);
  }
  const intent = intentFromXdr(envelopeXdr, passphrase);
  try {
    assertSignerNormalization(intent.operations, account, live.signers, intent.fee);
  } catch {
    refuse(COSIGN_REFUSED.signersChanged);
  }
  const attached = mapSignatures(tx, tx.hash(), live.signers);
  const required = Math.max(1, requiredSignatureWeight(intent.operations, live.thresholds));
  if (
    attached === null ||
    !attached.some((s) => s.key === account) ||
    !everySignatureNeeded(attached, required)
  ) {
    refuse(COSIGN_REFUSED.signersChanged);
  }
}
