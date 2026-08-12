import { test, expect } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  evaluateSignatureContributions,
  accumulatedWeight,
  type SignerContribution,
} from "@/lib/stellar/signature-weight";
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

test("evaluateSignatureContributions › non-ed25519 signer types never contribute (this issue's scope)", () => {
  const kpA = Keypair.random();
  const xdrStr = unsignedXdr(kpA.publicKey());
  const built = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
  built.sign(kpA);

  const signers: AccountSigner[] = [
    { type: "hash_x", key: "XA...", weight: 5 },
    { type: "preauth_tx", key: "TA...", weight: 5 },
  ];
  const contributions = evaluateSignatureContributions(
    built.toEnvelope().toXDR("base64"),
    Networks.TESTNET,
    signers
  );

  expect(contributions.every((c) => c.contributed === false)).toBe(true);
});
