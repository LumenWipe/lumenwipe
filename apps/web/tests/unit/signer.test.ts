import { test, expect } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { SecretKeySigner, WalletKitSigner } from "@/lib/stellar/signer";

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

test("WalletKitSigner › delegates to the injected kit signer with the right args and returns its result", async () => {
  const calls: Array<{ xdr: string; opts: { networkPassphrase: string; address: string } }> = [];
  const signer = new WalletKitSigner("GPUBLICKEYEXAMPLE", async (xdr, opts) => {
    calls.push({ xdr, opts });
    return { signedTxXdr: `signed:${xdr}` };
  });

  const result = await signer.sign("raw-xdr", Networks.TESTNET);

  expect(result).toBe("signed:raw-xdr");
  expect(calls).toEqual([
    { xdr: "raw-xdr", opts: { networkPassphrase: Networks.TESTNET, address: "GPUBLICKEYEXAMPLE" } },
  ]);
});

test("WalletKitSigner › publicKey is the address it was constructed with", () => {
  const signer = new WalletKitSigner("GPUBLICKEYEXAMPLE", async () => ({ signedTxXdr: "" }));
  expect(signer.publicKey).toBe("GPUBLICKEYEXAMPLE");
});

test("SecretKeySigner › sign() appends a second signature to an envelope that already carries one", async () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  const xdr = unsignedXdr(kpA);

  const signerA = new SecretKeySigner(kpA.secret());
  const onceSignedXdr = await signerA.sign(xdr, Networks.TESTNET);

  const signerB = new SecretKeySigner(kpB.secret());
  const twiceSignedXdr = await signerB.sign(onceSignedXdr, Networks.TESTNET);

  const finalTx = TransactionBuilder.fromXDR(twiceSignedXdr, Networks.TESTNET);
  expect(finalTx.signatures.length).toBe(2);
  expect(finalTx.signatures[0].hint().equals(kpA.signatureHint())).toBe(true);
  expect(finalTx.signatures[1].hint().equals(kpB.signatureHint())).toBe(true);

  // The first signature is untouched by the second sign() call.
  const onlyA = TransactionBuilder.fromXDR(onceSignedXdr, Networks.TESTNET);
  expect(onlyA.signatures[0].toXDR("base64")).toBe(finalTx.signatures[0].toXDR("base64"));
});

test("WalletKitSigner › passes an already-signed xdr through unmodified for the kit to append to", async () => {
  const kpA = Keypair.random();
  const preSignedXdr = await new SecretKeySigner(kpA.secret()).sign(
    unsignedXdr(kpA),
    Networks.TESTNET
  );

  let receivedXdr: string | null = null;
  const signer = new WalletKitSigner("GPUBLICKEYEXAMPLE", async (xdr) => {
    receivedXdr = xdr;
    return { signedTxXdr: xdr }; // stand-in for the kit appending its own signature
  });

  await signer.sign(preSignedXdr, Networks.TESTNET);

  expect(receivedXdr === preSignedXdr).toBe(true); // the class itself never strips or rebuilds the input
});
