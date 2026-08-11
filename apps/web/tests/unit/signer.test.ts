import { test, expect } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { SecretKeySigner } from "@/lib/stellar/signer";

function unsignedXdr(sourceKeypair: Keypair): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.manageData({ name: "close-me", value: null }));
  return builder.build().toXDR();
}

test("SecretKeySigner › publicKey matches the key it was constructed with", () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  expect(signer.publicKey).toBe(kp.publicKey());
});

test("SecretKeySigner › sign() returns a base64 envelope signed by that key", async () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  const xdr = unsignedXdr(kp);

  const signedXdr = await signer.sign(xdr, Networks.TESTNET);

  const signedTx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  expect(signedTx.signatures.length).toBe(1);
  const hint = signedTx.signatures[0].hint();
  expect(hint.equals(kp.signatureHint())).toBe(true);
});

test("SecretKeySigner › sign() does not mutate the original unsigned xdr string", async () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  const xdr = unsignedXdr(kp);
  const before = xdr;

  await signer.sign(xdr, Networks.TESTNET);

  expect(xdr).toBe(before);
});
