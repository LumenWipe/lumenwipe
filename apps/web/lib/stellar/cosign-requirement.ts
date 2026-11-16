import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { ExecutionTxBreakdown } from "@/types/close-api";
import type { ThresholdCategory } from "@/lib/stellar/thresholds";

export interface CosignInput {
  /** The account being closed, which is also its master key. */
  account: string;
  signers: readonly AccountSigner[];
  thresholds: AccountThresholds;
  /** The plan's transaction breakdown, or null when the plan does not give one. */
  transactions: readonly ExecutionTxBreakdown[] | null;
  viaRelay: boolean;
}

/**
 * `required`: a transaction removes the other signers without merging, so the master key must sign
 * it (`assertMasterSignsSignerRemoval`). `unknown`: the plan gives no breakdown to tell.
 */
export type MasterRule = "required" | "unknown" | "not-required";

/**
 * Whether "Sign on another device" can apply, which it does only on a transaction that just
 * removes the other signers (`cosignExport`). `removal`: the plan's removal transaction covers
 * nothing else. `none`: the plan's breakdown has no such transaction. `unknown`: the plan gives
 * no breakdown to tell.
 */
export type CrossDevice = "removal" | "none" | "unknown";

export interface CosignRequirement {
  /** How many of the account's keys must sign, or null when its keys alone cannot reach the
   *  high threshold. */
  needed: number | null;
  keys: number;
  /** How many of the plan's transactions need more than one key, or null when the plan does not
   *  say. */
  transactions: number | null;
  master: MasterRule;
  crossDevice: CrossDevice;
  masterKey: string;
  hashX: number;
  preAuth: number;
  signedPayload: number;
}

/** The fewest weights, heaviest first, that together reach `target`; null when all fall short. */
function fewestToReach(weights: readonly number[], target: number): number | null {
  if (target <= 0) return 0;
  const sorted = [...weights].sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!;
    if (sum >= target) return i + 1;
  }
  return null;
}

/** The threshold a transaction before the signer removal is signed against: nothing before it
 *  touches signers or merges, so only a claim-only round is below medium. */
function categoryBeforeRemoval(tx: ExecutionTxBreakdown): Exclude<ThresholdCategory, "high"> {
  return tx.covers.length > 0 && tx.covers.every((c) => c === "CLAIM_BALANCES") ? "low" : "med";
}

function masterRule(
  removal: ExecutionTxBreakdown | undefined,
  transactions: readonly ExecutionTxBreakdown[] | null,
  viaRelay: boolean
): MasterRule {
  if (transactions !== null) {
    return removal !== undefined && !removal.covers.includes("MERGE") ? "required" : "not-required";
  }
  return viaRelay ? "required" : "unknown";
}

function crossDevice(
  removal: ExecutionTxBreakdown | undefined,
  transactions: readonly ExecutionTxBreakdown[] | null
): CrossDevice {
  if (transactions === null) return "unknown";
  return removal?.covers.length === 1 ? "removal" : "none";
}

/**
 * Which of the account's keys must sign the close, and where. Null when one key is enough. Reads
 * the transaction order only from the plan's breakdown, never from an assumed one.
 */
export function cosignRequirement(input: CosignInput): CosignRequirement | null {
  const { account, signers, thresholds } = input;
  const keys = signers.filter((s) => s.type === "ed25519_public_key" && s.weight > 0);
  const weights = keys.map((k) => k.weight);
  // A threshold of 0 still needs one signature, which is still fewer than two keys.
  const keysFor = (threshold: number): number | null => fewestToReach(weights, threshold);

  const ordered =
    input.transactions === null ? null : [...input.transactions].sort((a, b) => a.order - b.order);
  const removalIndex = ordered?.findIndex((tx) => tx.covers.includes("NORMALIZE_SIGNERS")) ?? -1;
  const removal = removalIndex >= 0 ? ordered?.[removalIndex] : undefined;
  const master = masterRule(removal, ordered, input.viaRelay);

  // The N keys sign every transaction up to the removal, so they must reach the highest threshold
  // any of them is signed against, which is above the high one when the medium threshold is. With
  // no breakdown the plan may hold a DeFi exit, a medium round before the removal.
  const before = ordered === null ? null : removalIndex < 0 ? [] : ordered.slice(0, removalIndex);
  const target = Math.max(
    thresholds.high,
    ...(before === null
      ? [thresholds.med]
      : before.map((tx) => thresholds[categoryBeforeRemoval(tx)]))
  );
  let needed = keysFor(target);
  if (master === "required") {
    const masterWeight = keys.find((k) => k.key === account)?.weight ?? 0;
    const others = fewestToReach(
      keys.filter((k) => k.key !== account).map((k) => k.weight),
      Math.max(1, target) - masterWeight
    );
    needed = others === null ? null : 1 + others;
  }
  if (needed !== null && needed < 2) return null;
  const count = (type: AccountSigner["type"]): number =>
    signers.filter((s) => s.type === type && s.weight > 0).length;
  const hashX = count("hash_x");
  const preAuth = count("preauth_tx");
  // Nothing in this flow can reach the threshold: the plan is blocked, and there is nothing true
  // to say about who signs.
  if (needed === null && hashX + preAuth === 0) return null;

  const needsMoreThanOne = (tx: ExecutionTxBreakdown): boolean => {
    if (tx === removal) return true;
    const n = keysFor(thresholds[categoryBeforeRemoval(tx)]);
    return n === null || n >= 2;
  };
  const transactions =
    ordered === null || removalIndex < 0
      ? null
      : ordered.slice(0, removalIndex + 1).filter(needsMoreThanOne).length;

  return {
    needed,
    keys: keys.length,
    transactions,
    master,
    crossDevice: crossDevice(removal, ordered),
    masterKey: account,
    hashX,
    preAuth,
    signedPayload: count("ed25519_signed_payload"),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-8)}`;
}

/** The statement, as sentences, for the review screen and the signing step's multisig notice. */
export function cosignStatement(r: CosignRequirement): string[] {
  const sentences: string[] = [];
  if (r.needed === null) {
    sentences.push(
      "This account's keys alone cannot reach the signing weight this close needs. It also needs its hash(x) or pre-authorized transaction signers, used in this browser.",
      "Its keys must also sign here, in this browser, during this close."
    );
  } else {
    const who =
      r.needed === r.keys
        ? `all ${r.keys} of its keys`
        : `at least ${r.needed} of its ${plural(r.keys, "key", "keys")}`;
    const where =
      r.transactions === null
        ? " for this close"
        : `, on ${plural(r.transactions, "transaction", "transactions")} of this close`;
    sentences.push(
      `This account needs signatures from ${who}${where}.`,
      r.crossDevice === "none"
        ? `These ${r.needed} must sign here, in this browser, during this close.`
        : `These ${r.needed} sign during this close.`
    );
  }
  if (r.master === "required") {
    sentences.push(
      r.needed === null
        ? `One transaction removes the other signers without closing the account, so the master key, ${shortKey(r.masterKey)}, must sign it. After it, the master key alone completes the close.`
        : `One transaction removes the other signers without closing the account, so the master key, ${shortKey(r.masterKey)}, must be one of these ${r.needed}. After it, the master key alone completes the close.`
    );
  } else if (r.master === "unknown") {
    sentences.push(
      `If a transaction removes the other signers before the final transaction, the master key, ${shortKey(r.masterKey)}, must sign it as well.`
    );
  }
  sentences.push(...whereOthersSign(r));
  if (r.hashX > 0) {
    sentences.push(
      `It also has ${plural(r.hashX, "hash(x) signer", "hash(x) signers")}. A preimage is entered in this browser, and only on the step that removes its own signer.`
    );
  }
  if (r.preAuth > 0) {
    sentences.push(
      `It also has ${plural(r.preAuth, "pre-authorized transaction signer", "pre-authorized transaction signers")}. ${r.preAuth === 1 ? "It is" : "Each is"} used by submitting that exact transaction in this browser, not by signing.`
    );
  }
  if (r.signedPayload > 0) {
    sentences.push(
      `It also has ${plural(r.signedPayload, "signed-payload signer", "signed-payload signers")}, which cannot sign in LumenWipe.`
    );
  }
  return sentences;
}

/** What "Sign on another device" can do for this close, under the conditions `cosignExport`
 *  offers it on. */
function whereOthersSign(r: CosignRequirement): string[] {
  if (r.needed === null) {
    return [
      "Another device cannot add the missing weight: it signs only with keys, and this account's keys alone do not reach it.",
    ];
  }
  if (r.crossDevice === "none") {
    return [
      "Another device can sign only a transaction that just removes the other signers, and this close has none.",
    ];
  }
  if (r.crossDevice === "unknown") {
    return [
      "If a transaction of this close only removes the other signers, the other keys can sign it on another device after the master key signs it here; every other transaction is signed here, in this browser.",
    ];
  }
  const sentences = [
    'On that transaction the master key signs here first, and the other keys can sign here or on another device, under "Sign on another device".',
  ];
  if (r.transactions !== null && r.transactions > 1) {
    sentences.push(
      "Its other transactions that need several keys are signed here, in this browser."
    );
  }
  return sentences;
}
