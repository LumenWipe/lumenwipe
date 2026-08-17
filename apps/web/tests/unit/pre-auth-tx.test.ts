import { test, expect } from "bun:test";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { verifyPreAuthTxHash, InvalidPreAuthTxError } from "@/lib/stellar/pre-auth-tx";

function unsignedXdr(sourcePublicKey: string, sequence = "1"): string {
  const account = new Account(sourcePublicKey, sequence);
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }))
    .setTimeout(30)
    .build()
    .toXDR();
}

test("verifyPreAuthTxHash › a transaction whose hash matches the signer's key is accepted", () => {
  const source = Keypair.random();
  const xdr = unsignedXdr(source.publicKey());
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  const signerKey = StrKey.encodePreAuthTx(tx.hash());

  const verified = verifyPreAuthTxHash(xdr, Networks.TESTNET, signerKey);

  expect(verified.hash().toString("hex")).toBe(tx.hash().toString("hex"));
});

test("verifyPreAuthTxHash › a transaction whose hash does not match the signer's key is rejected", () => {
  const source = Keypair.random();
  const xdr = unsignedXdr(source.publicKey());
  const wrongSignerKey = StrKey.encodePreAuthTx(Buffer.alloc(32, 7));

  expect(() => verifyPreAuthTxHash(xdr, Networks.TESTNET, wrongSignerKey)).toThrow(
    InvalidPreAuthTxError
  );
  expect(() => verifyPreAuthTxHash(xdr, Networks.TESTNET, wrongSignerKey)).toThrow(
    /does not match/i
  );
});

test("verifyPreAuthTxHash › unparseable xdr is rejected before hashing", () => {
  const signerKey = StrKey.encodePreAuthTx(Buffer.alloc(32, 1));

  expect(() => verifyPreAuthTxHash("not valid xdr", Networks.TESTNET, signerKey)).toThrow(
    InvalidPreAuthTxError
  );
  expect(() => verifyPreAuthTxHash("not valid xdr", Networks.TESTNET, signerKey)).toThrow(
    /valid transaction/i
  );
});

test("verifyPreAuthTxHash › a fee-bump transaction is rejected", () => {
  const source = Keypair.random();
  const inner = TransactionBuilder.fromXDR(
    unsignedXdr(source.publicKey()),
    Networks.TESTNET
  ) as Transaction;
  inner.sign(source);
  const feeBumper = Keypair.random();
  const feeBumpXdr = TransactionBuilder.buildFeeBumpTransaction(
    feeBumper,
    "200",
    inner,
    Networks.TESTNET
  ).toXDR();
  const signerKey = StrKey.encodePreAuthTx(Buffer.alloc(32, 1));

  expect(() => verifyPreAuthTxHash(feeBumpXdr, Networks.TESTNET, signerKey)).toThrow(
    InvalidPreAuthTxError
  );
  expect(() => verifyPreAuthTxHash(feeBumpXdr, Networks.TESTNET, signerKey)).toThrow(/fee-bump/i);

  // Sanity check that this really is what TransactionBuilder.fromXDR returns for a fee-bump
  // envelope, so the rejection above is exercising the intended branch.
  expect(TransactionBuilder.fromXDR(feeBumpXdr, Networks.TESTNET)).toBeInstanceOf(
    FeeBumpTransaction
  );
});
