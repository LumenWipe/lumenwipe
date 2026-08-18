import { test, expect } from "bun:test";
import {
  Account,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  evaluateSignatureContributions,
  accumulatedWeight,
  type SignerContribution,
} from "@/lib/stellar/signature-weight";
import { HashXPreimageSigner } from "@/lib/stellar/signer";
import type { AccountSigner } from "@/types/account";

function unsignedXdr(sourcePublicKey: string): string {
  const builder = new TransactionBuilder(new Account(sourcePublicKey, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.manageData({ name: "close-me", value: null }));
  return builder.build().toXDR();
}

test("accumulatedWeight › sums only the contributed signers' weight", () => {
  const contributions: SignerContribution[] = [
    { signer: { type: "ed25519_public_key", key: "GA", weight: 2 }, contributed: true },
    { signer: { type: "ed25519_public_key", key: "GB", weight: 3 }, contributed: false },
  ];
  expect(accumulatedWeight(contributions)).toBe(2);
});

test("accumulatedWeight › two signers of weight 1 each sum to exactly 2", () => {
  const contributions: SignerContribution[] = [
    { signer: { type: "ed25519_public_key", key: "GA", weight: 1 }, contributed: true },
    { signer: { type: "ed25519_public_key", key: "GB", weight: 1 }, contributed: true },
  ];
  expect(accumulatedWeight(contributions)).toBe(2); // exact-boundary: meets a threshold of 2, not just exceeds it
});

test("evaluateSignatureContributions › a single ed25519 signature is matched to its signer", () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  const xdrStr = unsignedXdr(kpA.publicKey());
  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  built.sign(kpA);

  const signers: AccountSigner[] = [
    { type: "ed25519_public_key", key: kpA.publicKey(), weight: 1 },
    { type: "ed25519_public_key", key: kpB.publicKey(), weight: 1 },
  ];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions.find((c) => c.signer.key === kpA.publicKey())?.contributed).toBe(true);
  expect(contributions.find((c) => c.signer.key === kpB.publicKey())?.contributed).toBe(false);
  expect(accumulatedWeight(contributions)).toBe(1);
});

test("evaluateSignatureContributions › accumulates as a second signer signs the same envelope", () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  const xdrStr = unsignedXdr(kpA.publicKey());
  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  built.sign(kpA);
  built.sign(kpB); // simulates a second signer contributing onto the same envelope

  const signers: AccountSigner[] = [
    { type: "ed25519_public_key", key: kpA.publicKey(), weight: 1 },
    { type: "ed25519_public_key", key: kpB.publicKey(), weight: 1 },
  ];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(accumulatedWeight(contributions)).toBe(2);
});

test("evaluateSignatureContributions › a matching hint with an invalid signature is not counted", () => {
  const kpA = Keypair.random();
  const xdrStr = unsignedXdr(kpA.publicKey());
  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  // Craft a decorated signature with A's real hint but garbage signature bytes - hint matching
  // alone must not be enough to count A's weight.
  built.signatures.push(
    new xdr.DecoratedSignature({
      hint: kpA.signatureHint(),
      signature: Buffer.alloc(64, 1),
    })
  );

  const signers: AccountSigner[] = [
    { type: "ed25519_public_key", key: kpA.publicKey(), weight: 1 },
  ];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions[0].contributed).toBe(false);
});

test("evaluateSignatureContributions › pre-auth-tx signers never contribute (#102's scope)", () => {
  const kpA = Keypair.random();
  const xdrStr = unsignedXdr(kpA.publicKey());
  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  built.sign(kpA);

  const signers: AccountSigner[] = [
    { type: "preauth_tx", key: StrKey.encodePreAuthTx(Buffer.alloc(32, 7)), weight: 5 },
  ];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions.every((c) => c.contributed === false)).toBe(true);
});

test("evaluateSignatureContributions › a correct hash(x) preimage is counted toward accumulated weight", () => {
  const source = Keypair.random();
  const preimage = Buffer.from("deadbeef", "hex");
  const signerKey = StrKey.encodeSha256Hash(hash(preimage));
  const xdrStr = unsignedXdr(source.publicKey());

  const signedXdr = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  signedXdr.signHashX(preimage);

  const signers: AccountSigner[] = [{ type: "hash_x", key: signerKey, weight: 3 }];
  const contributions = evaluateSignatureContributions(
    signedXdr.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions[0].contributed).toBe(true);
  expect(accumulatedWeight(contributions)).toBe(3);
});

test("evaluateSignatureContributions › an unrelated preimage does not count toward a different hash(x) signer", () => {
  const source = Keypair.random();
  const wrongPreimage = Buffer.from("cafebabe", "hex");
  const knownSignerKey = StrKey.encodeSha256Hash(hash(Buffer.from("deadbeef", "hex")));
  const xdrStr = unsignedXdr(source.publicKey());

  const signedXdr = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  signedXdr.signHashX(wrongPreimage); // signs for a *different* hash(x) key than knownSignerKey

  const signers: AccountSigner[] = [{ type: "hash_x", key: knownSignerKey, weight: 3 }];
  const contributions = evaluateSignatureContributions(
    signedXdr.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions[0].contributed).toBe(false);
  expect(accumulatedWeight(contributions)).toBe(0);
});

test("evaluateSignatureContributions › a hint match with a non-matching preimage is not counted (hint alone isn't proof)", () => {
  const source = Keypair.random();
  const preimage = Buffer.from("deadbeef", "hex");
  const signerKey = StrKey.encodeSha256Hash(hash(preimage));
  const digest = hash(preimage);
  const xdrStr = unsignedXdr(source.publicKey());

  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  // Craft a decorated signature with the real hint but garbage "preimage" bytes that don't
  // actually hash to the signer's digest - mirrors the existing ed25519 forged-hint test.
  built.signatures.push(
    new xdr.DecoratedSignature({
      hint: digest.subarray(digest.length - 4),
      signature: Buffer.alloc(8, 1),
    })
  );

  const signers: AccountSigner[] = [{ type: "hash_x", key: signerKey, weight: 3 }];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions[0].contributed).toBe(false);
});

test("evaluateSignatureContributions › recognizes HashXPreimageSigner's output end to end", async () => {
  const source = Keypair.random();
  const preimage = Buffer.from("01020304", "hex");
  const signerKey = StrKey.encodeSha256Hash(hash(preimage));
  const xdrStr = unsignedXdr(source.publicKey());

  const signedXdr = await new HashXPreimageSigner(signerKey, preimage).sign(
    xdrStr,
    Networks.TESTNET
  );

  const contributions = evaluateSignatureContributions(signedXdr, Networks.TESTNET, [
    { type: "hash_x", key: signerKey, weight: 2 },
  ]);
  expect(accumulatedWeight(contributions)).toBe(2);
});

test("evaluateSignatureContributions › a decorated signature from a key that isn't a known signer at all contributes nothing", () => {
  const knownSigner = Keypair.random();
  const attacker = Keypair.random(); // not in the account's signer list at all
  const xdr = unsignedXdr(knownSigner.publicKey());

  const built = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  built.sign(attacker); // a real, valid signature - just from an unrelated key
  const tamperedXdr = built.toEnvelope().toXDR("base64");

  const signers: AccountSigner[] = [
    { type: "ed25519_public_key", key: knownSigner.publicKey(), weight: 1 },
  ];
  const contributions = evaluateSignatureContributions(tamperedXdr, Networks.TESTNET, signers);

  expect(contributions).toEqual([{ signer: signers[0], contributed: false }]);
  expect(accumulatedWeight(contributions)).toBe(0);
});
