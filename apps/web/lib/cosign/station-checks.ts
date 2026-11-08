import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { serializeCosignArtifact, type CosignArtifact } from "@/lib/cosign/artifact";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { toHex } from "@/lib/stellar/hex";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import {
  accumulatedWeight,
  addedSigners,
  evaluateSignatureContributions,
} from "@/lib/stellar/signature-weight";
import { VerificationError, verifyCloseTransaction } from "@/lib/stellar/verify";
import { UserFacingError } from "@/lib/utils/user-error";
import type { AccountSigner, AccountState, AccountThresholds } from "@/types/account";
import type { IntentOperation } from "@/types/close-api";

/**
 * The cosign station's checks (docs/multisig-cosigning.md Sections 7.1 and 7.2). Everything is
 * judged against the network the cosigner chose, the account the cosigner typed and the station's
 * own live read of that account, never against anything the artifact says about itself.
 */

/** Seconds that must be left when a request is imported, and when the signer is asked. */
export const IMPORT_FLOOR_SECONDS = 90;
export const SIGNING_FLOOR_SECONDS = 60;

export const REFUSED = {
  network: "This request is for another network.",
  account: "This request is for another account.",
  sequence: "This transaction can no longer be used.",
  expiresSoon: "This request expires too soon. Ask for a new one.",
  notYetValid: "This request is not valid yet. Ask for a new one.",
  notNormalization: "This step cannot be signed on another device.",
  closeBlocked:
    "This account has a setting that permanently stops it from being closed, so this step cannot be signed here.",
  masterWeightZero:
    "The master key on this account has weight 0. Removing the other signers would leave no key able to act on the account, so this step cannot be signed.",
  unreachable:
    "This account's signers cannot reach the weight this step needs, so it can never be completed. Do not sign.",
  fingerprint: "The characters do not match. Do not sign. Check them with the initiator.",
  notSigner: "This key is not one of the account's signers.",
  tooLittleTime: "Too little time is left. Ask for a new request.",
  notApproved: "The signed transaction does not match what you approved.",
  alreadySigned: "This request already carries signatures. Ask for a new one.",
} as const;

/** What the station read about the account, live, before anything was imported. */
export type LiveAccount = Pick<
  AccountState,
  "sequence" | "signers" | "thresholds" | "authImmutable"
>;

export interface NormalizationSummary {
  /** The master key, which is the account's own address. */
  master: string;
  removedSigners: AccountSigner[];
  thresholds: AccountThresholds;
  feeStroops: string;
}

export interface CheckedRequest {
  network: Network;
  account: string;
  /** The unsigned envelope, as imported. */
  xdr: string;
  /** The transaction hash, hex, computed here over the chosen network's passphrase. */
  hash: string;
  /** The transaction's upper time bound, unix seconds. */
  maxTime: number;
  summary: NormalizationSummary;
}

function refuse(message: string): never {
  throw new UserFacingError(message);
}

/** The 16 characters the initiator reads out: the first and last eight of the hash. */
export function fingerprintOf(hash: string): string {
  return `${hash.slice(0, 8)}${hash.slice(-8)}`;
}

/** Whether the cosigner typed this hash's fingerprint. Spaces, dots and ellipses are ignored, and
 *  case does not matter. */
export function fingerprintMatches(typed: string, hash: string): boolean {
  return typed.replace(/[\s.…]/g, "").toLowerCase() === fingerprintOf(hash).toLowerCase();
}

function masterWeightOf(live: LiveAccount, account: string): number {
  return (
    live.signers.find((s) => s.key === account && s.type === "ed25519_public_key")?.weight ?? 0
  );
}

/** The refusals the API's normalization safety check (`assessSignerNormalizationSafety`) and its
 *  merge blocker make, judged here on the station's own read. */
function assertAccountCanBeNormalized(live: LiveAccount, account: string): void {
  if (live.authImmutable) refuse(REFUSED.closeBlocked);
  if (masterWeightOf(live, account) < 1) refuse(REFUSED.masterWeightZero);
  const satisfiable = live.signers
    .filter(
      (s) => s.type === "ed25519_public_key" || s.type === "hash_x" || s.type === "preauth_tx"
    )
    .reduce((sum, s) => sum + s.weight, 0);
  if (satisfiable < live.thresholds.high) refuse(REFUSED.unreachable);
}

type SetOptions = Extract<IntentOperation, { type: "set_options" }>;

const isRemoval = (op: SetOptions): boolean =>
  op.signer !== null &&
  op.lowThreshold === null &&
  op.medThreshold === null &&
  op.highThreshold === null;

const isReset = (op: SetOptions): boolean =>
  op.signer === null &&
  op.lowThreshold !== null &&
  op.medThreshold !== null &&
  op.highThreshold !== null;

/**
 * The v1 station signs signer normalization only (Section 7.2): every operation is a `set_options`
 * of the account that either removes one of its signers other than the master key, each of them
 * exactly once, or is the one threshold reset, which lowers every threshold to what the master key
 * alone meets.
 */
function normalizationSummary(
  operations: IntentOperation[],
  account: string,
  live: LiveAccount,
  feeStroops: string
): NormalizationSummary {
  const masterWeight = masterWeightOf(live, account);
  const removedSigners: AccountSigner[] = [];
  let reset: SetOptions | null = null;
  if (operations.length === 0) refuse(REFUSED.notNormalization);
  for (const op of operations) {
    if (op.type !== "set_options" || op.source !== account) refuse(REFUSED.notNormalization);
    if (
      op.masterWeight !== null ||
      op.homeDomain !== null ||
      op.setFlags !== null ||
      op.clearFlags !== null ||
      op.inflationDest !== null
    ) {
      refuse(REFUSED.notNormalization);
    }
    if (isRemoval(op)) {
      const signer = op.signer!;
      const known = live.signers.some((s) => s.key === signer.key && s.type === signer.type);
      if (signer.weight !== 0 || signer.key === account || !known) {
        refuse(REFUSED.notNormalization);
      }
      if (removedSigners.some((s) => s.key === signer.key)) refuse(REFUSED.notNormalization);
      removedSigners.push(signer);
    } else if (isReset(op) && reset === null) {
      reset = op;
    } else {
      refuse(REFUSED.notNormalization);
    }
  }
  // Each removal is a distinct live signer other than the master key, so an equal count is the
  // exact set: sole control holds only when every other signer goes, whatever its type.
  if (removedSigners.length !== live.signers.filter((s) => s.key !== account).length) {
    refuse(REFUSED.notNormalization);
  }
  if (
    reset === null ||
    reset.lowThreshold! > masterWeight ||
    reset.medThreshold! > masterWeight ||
    reset.highThreshold! > masterWeight
  ) {
    refuse(REFUSED.notNormalization);
  }
  return {
    master: account,
    removedSigners,
    thresholds: { low: reset.lowThreshold!, med: reset.medThreshold!, high: reset.highThreshold! },
    feeStroops,
  };
}

function decodePlain(xdr: string, passphrase: string): Transaction {
  const tx = TransactionBuilder.fromXdr(xdr, passphrase);
  if (tx instanceof FeeBumpTransaction) refuse(REFUSED.notNormalization);
  return tx;
}

/**
 * Checks an imported request, in order, before anything is shown as signable: the network and
 * account the cosigner chose, an unsigned envelope on the account's next sequence number, the time
 * left, the normalization-only allowlist, and `verify()` with `preAuthorized: false`.
 */
export function checkRequest(input: {
  artifact: CosignArtifact;
  network: Network;
  account: string;
  live: LiveAccount;
  nowSeconds: number;
}): CheckedRequest {
  const { artifact, network, account, live, nowSeconds } = input;
  if (artifact.direction !== "request") refuse(REFUSED.notNormalization);
  if (artifact.network !== network) refuse(REFUSED.network);
  const passphrase = NETWORK_PASSPHRASES[network];
  const tx = decodePlain(artifact.envelope, passphrase);
  if (artifact.account !== account || tx.source !== account) refuse(REFUSED.account);
  if (tx.signatures.length > 0) refuse(REFUSED.alreadySigned);
  if (BigInt(tx.sequence) !== BigInt(live.sequence) + BigInt(1)) refuse(REFUSED.sequence);
  assertAccountCanBeNormalized(live, account);

  // A v1 station signs a transaction bounded by time alone: no other precondition is built for one.
  if (
    tx.ledgerBounds !== undefined ||
    tx.minAccountSequence !== undefined ||
    tx.minAccountSequenceAge !== undefined ||
    tx.minAccountSequenceLedgerGap !== undefined ||
    (tx.extraSigners?.length ?? 0) > 0
  ) {
    refuse(REFUSED.notNormalization);
  }
  const minTime = Number(tx.timeBounds?.minTime ?? 0);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (minTime > nowSeconds) refuse(REFUSED.notYetValid);
  if (maxTime === 0 || maxTime - nowSeconds < IMPORT_FLOOR_SECONDS) refuse(REFUSED.expiresSoon);

  const intent = intentFromXdr(artifact.envelope, passphrase);
  const summary = normalizationSummary(intent.operations, account, live, intent.fee);
  try {
    verifyCloseTransaction({
      unsignedXdr: artifact.envelope,
      network,
      preAuthorized: false,
      expected: {
        source: account,
        destination: account,
        nativeBalance: "0",
        memo: null,
        memoType: null,
        claimTrustlineAssets: [],
        accountSigners: live.signers,
        accountThresholds: live.thresholds,
        transfers: {},
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        ...exitExpectations(null, network),
      },
    });
  } catch (err) {
    if (err instanceof VerificationError) refuse(err.message);
    throw err;
  }
  return {
    network,
    account,
    xdr: artifact.envelope,
    hash: toHex(tx.hash()),
    maxTime,
    summary,
  };
}

/** The signer must be one of the account's ed25519 signers in the live read, with weight. */
export function assertStationSigner(live: LiveAccount, publicKey: string): void {
  const signer = live.signers.find((s) => s.key === publicKey);
  if (!signer || signer.type !== "ed25519_public_key" || signer.weight <= 0) {
    refuse(REFUSED.notSigner);
  }
}

/** Run right before the signer is asked: the hub still needs the return trip and a submission. */
export function assertSigningTime(request: CheckedRequest, nowSeconds: number): void {
  if (request.maxTime - nowSeconds < SIGNING_FLOOR_SECONDS) refuse(REFUSED.tooLittleTime);
}

/**
 * Checks what the signer returned and builds the response from it: the signed transaction is the
 * one approved, and the weight rose by the named signer's own signature. The response holds that
 * one signature on the request's own envelope, and nothing else the signer may have added.
 */
export function responseFromSigned(input: {
  request: CheckedRequest;
  signedXdr: string;
  live: LiveAccount;
  signerKey: string;
}): string {
  const { request, signedXdr, live, signerKey } = input;
  const passphrase = NETWORK_PASSPHRASES[request.network];
  let signed: Transaction;
  try {
    signed = decodePlain(signedXdr, passphrase);
  } catch {
    refuse(REFUSED.notApproved);
  }
  const hash = signed.hash();
  if (toHex(hash) !== request.hash) refuse(REFUSED.notApproved);

  const before = evaluateSignatureContributions(request.xdr, passphrase, live.signers);
  const after = evaluateSignatureContributions(signedXdr, passphrase, live.signers);
  const ownSignerAdded = addedSigners(before, after).some((s) => s.key === signerKey);
  if (!ownSignerAdded || accumulatedWeight(after) <= accumulatedWeight(before)) {
    refuse(REFUSED.notApproved);
  }

  const keypair = Keypair.fromPublicKey(signerKey);
  const hint = keypair.signatureHint();
  const own = signed.signatures.find((sig) => {
    const sigHint = sig.hint.toBytes();
    return (
      sigHint.length === hint.length &&
      sigHint.every((byte, i) => byte === hint[i]) &&
      keypair.verify(hash, sig.signature.toBytes())
    );
  });
  if (!own) refuse(REFUSED.notApproved);

  const response = decodePlain(request.xdr, passphrase);
  response.addDecoratedSignature(own);
  return serializeCosignArtifact({
    direction: "response",
    network: request.network,
    account: request.account,
    envelope: response.toEnvelope().toXDR("base64"),
  });
}
