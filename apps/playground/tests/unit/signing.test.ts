import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  type xdr,
} from "@stellar/stellar-sdk";
import type { SignerState } from "@/lib/horizon-submit";
import {
  operationThreshold,
  requiredWeight,
  signForWeight,
  signingKeyOf,
  type SigningKey,
  type ThresholdCategory,
} from "@/lib/signing";
import { PLAYGROUND_CLOSE_OPERATION_TYPES } from "@/lib/verify";

// The signing model of a playground close: the weight a transaction needs comes from the demo's
// live thresholds, and it is signed only with the demo key and the signers the session recorded.
// Keys and preimages are generated per run.

const demo = Keypair.random();
const other = Keypair.random().publicKey();
const asset = new Asset("LWDEMO", Keypair.random().publicKey());

function tx(ops: xdr.Operation[]): Transaction {
  const builder = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(30);
  ops.forEach((op) => builder.addOperation(op));
  return builder.build();
}

// stellar-core's `getThresholdLevel` for one operation of every type the playground verifier lets a
// close contain: `AccountMergeOpFrame` HIGH, `ClaimClaimableBalanceOpFrame` LOW, `SetOptionsOpFrame`
// HIGH when it touches a signer, the master weight or a threshold, and the `OperationFrame`
// default MEDIUM for the rest.
const CORE_LEVELS: Record<string, [ThresholdCategory, xdr.Operation]> = {
  accountMerge: ["high", Operation.accountMerge({ destination: other })],
  payment: ["med", Operation.payment({ destination: other, asset, amount: "1" })],
  changeTrust: ["med", Operation.changeTrust({ asset, limit: "0" })],
  manageData: ["med", Operation.manageData({ name: "k", value: null })],
  manageSellOffer: [
    "med",
    Operation.manageSellOffer({
      selling: asset,
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "1",
    }),
  ],
  setOptions: ["high", Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 0 } })],
  pathPaymentStrictSend: [
    "med",
    Operation.pathPaymentStrictSend({
      sendAsset: asset,
      sendAmount: "1",
      destination: demo.publicKey(),
      destAsset: Asset.native(),
      destMin: "1",
      path: [],
    }),
  ],
  claimClaimableBalance: [
    "low",
    Operation.claimClaimableBalance({ balanceId: `00000000${"a".repeat(64)}` }),
  ],
  revokeTrustlineSponsorship: [
    "med",
    Operation.revokeTrustlineSponsorship({ account: other, asset }),
  ],
  revokeDataSponsorship: ["med", Operation.revokeDataSponsorship({ account: other, name: "k" })],
  invokeHostFunction: [
    "med",
    Operation.invokeContractFunction({
      contract: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
      function: "remove_liquidity",
      args: [],
    }),
  ],
};

describe("threshold levels", () => {
  test("agree with stellar-core for every operation type the playground verifier allows", () => {
    expect(Object.keys(CORE_LEVELS).sort()).toEqual([...PLAYGROUND_CLOSE_OPERATION_TYPES].sort());
    for (const [type, [level, op]] of Object.entries(CORE_LEVELS)) {
      const [parsed] = tx([op]).operations;
      expect(String(parsed!.type)).toBe(type);
      expect([type, operationThreshold(parsed!)]).toEqual([type, level]);
    }
  });

  test("a setOptions that touches no signer, weight or threshold is medium", () => {
    const [op] = tx([Operation.setOptions({ homeDomain: "example.org" })]).operations;
    expect(operationThreshold(op!)).toBe("med");
  });

  test("an operation type outside the table counts as high", () => {
    const [op] = tx([Operation.bumpSequence({ bumpTo: "5" })]).operations;
    expect(operationThreshold(op!)).toBe("high");
  });

  test("the weight is the strictest operation's live threshold, never under one", () => {
    const state = (low: number, med: number, high: number): SignerState => ({
      signers: [],
      thresholds: { low, med, high },
    });
    const claim = CORE_LEVELS.claimClaimableBalance![1];
    const data = CORE_LEVELS.manageData![1];
    const merge = CORE_LEVELS.accountMerge![1];
    expect(requiredWeight(tx([claim]), state(1, 2, 3))).toBe(1);
    expect(requiredWeight(tx([claim, data]), state(1, 2, 3))).toBe(2);
    expect(requiredWeight(tx([claim, data, merge]), state(1, 2, 3))).toBe(3);
    expect(requiredWeight(tx([merge]), state(0, 0, 0))).toBe(1);
  });
});

describe("signing with the recorded set", () => {
  const cosigners = [Keypair.random(), Keypair.random()];
  const preimage = randomBytes(32);
  const hashKey = StrKey.encodeSha256Hash(hash(preimage));
  const keys: SigningKey[] = [
    { type: "ed25519_public_key", key: cosigners[0]!.publicKey(), keypair: cosigners[0]! },
    { type: "hash_x", key: hashKey, preimage },
    { type: "ed25519_public_key", key: cosigners[1]!.publicKey(), keypair: cosigners[1]! },
  ];
  const live = (...signers: [string, string][]): SignerState => ({
    signers: [
      { key: demo.publicKey(), type: "ed25519_public_key", weight: 1 },
      ...signers.map(([type, key]) => ({ type, key, weight: 1 })),
    ],
    thresholds: { low: 2, med: 2, high: 2 },
  });
  const hints = (t: Transaction): string[] =>
    t.signatures.map((s) => Buffer.from(s.hint.toBytes()).toString("hex"));
  const hintOf = (kp: Keypair): string => Buffer.from(kp.signatureHint()).toString("hex");

  test("the demo key first, then a hash(x) preimage, stopping at the required weight", () => {
    const t = tx([CORE_LEVELS.accountMerge![1]]);
    const state = live(["ed25519_public_key", cosigners[0]!.publicKey()], ["hash_x", hashKey]);
    expect(signForWeight(t, demo, keys, state, 2)).toBe(2);
    expect(t.signatures).toHaveLength(2);
    expect(hints(t)[0]).toBe(hintOf(demo));
    const hashSig = t.signatures[1]!;
    const digest = Buffer.from(hash(Buffer.from(hashSig.signature.toBytes())));
    expect(digest.equals(StrKey.decodeSha256Hash(hashKey))).toBe(true);
  });

  test("a recorded co-signer the account no longer lists is not signed with", () => {
    const t = tx([CORE_LEVELS.accountMerge![1]]);
    expect(signForWeight(t, demo, keys, live(), 2)).toBe(1);
    expect(hints(t)).toEqual([hintOf(demo)]);
  });

  test("a live signer the session did not record is never signed for", () => {
    const stranger = Keypair.random();
    const t = tx([CORE_LEVELS.accountMerge![1]]);
    const state = live(["ed25519_public_key", stranger.publicKey()]);
    expect(signForWeight(t, demo, [], state, 2)).toBe(1);
    expect(hints(t)).toEqual([hintOf(demo)]);
  });

  test("short of the weight, it returns what it reached and the caller refuses to submit", () => {
    const t = tx([CORE_LEVELS.accountMerge![1]]);
    const state = live(["ed25519_public_key", cosigners[0]!.publicKey()]);
    expect(signForWeight(t, demo, keys, state, 3)).toBe(2);
  });

  test("a demo key the account gives no weight adds no signature", () => {
    const t = tx([CORE_LEVELS.accountMerge![1]]);
    const state: SignerState = {
      signers: [
        { key: demo.publicKey(), type: "ed25519_public_key", weight: 0 },
        { key: cosigners[0]!.publicKey(), type: "ed25519_public_key", weight: 1 },
      ],
      thresholds: { low: 1, med: 1, high: 1 },
    };
    expect(signForWeight(t, demo, keys, state, 1)).toBe(1);
    expect(hints(t)).toEqual([hintOf(cosigners[0]!)]);
  });

  test("a signing key is built only from a secret that signs for the recorded key", () => {
    const kp = Keypair.random();
    expect(signingKeyOf("ed25519_public_key", kp.publicKey(), kp.secret()).key).toBe(
      kp.publicKey()
    );
    expect(() =>
      signingKeyOf("ed25519_public_key", Keypair.random().publicKey(), kp.secret())
    ).toThrow();
    expect(signingKeyOf("hash_x", hashKey, preimage.toString("hex")).key).toBe(hashKey);
    expect(() => signingKeyOf("hash_x", hashKey, randomBytes(32).toString("hex"))).toThrow();
    expect(() => signingKeyOf("preauth_tx", hashKey, "00")).toThrow();
  });
});
