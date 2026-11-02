import { describe, expect, test } from "bun:test";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { mergesAccount, submissionHash, submissionValidUntil } from "@/lib/stellar/submission";
import { toHex } from "@/lib/stellar/hex";

const PASSPHRASE = Networks.TESTNET;
const SOURCE = Keypair.random();
const COSIGNER = Keypair.random();
const SPONSOR = Keypair.random();
const DESTINATION = Keypair.random().publicKey();

function merge(fee = "100", timeout = 300): Transaction {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), "100"), {
    fee,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.accountMerge({ destination: DESTINATION }))
    .setTimeout(timeout)
    .build();
}

function sponsored(inner: Transaction): FeeBumpTransaction {
  const wrapped = TransactionBuilder.buildFeeBumpTransaction(SPONSOR, "200", inner, PASSPHRASE);
  wrapped.sign(SPONSOR);
  return wrapped;
}

describe("submissionHash", () => {
  test("is the hash the envelope itself reports", () => {
    const tx = merge();
    expect(submissionHash(tx.toXDR(), PASSPHRASE)).toBe(toHex(tx.hash()));
  });

  test("a signature added after hashing leaves an inner hash unchanged", () => {
    const tx = merge();
    tx.sign(SOURCE);
    const before = submissionHash(tx.toXDR(), PASSPHRASE);
    tx.sign(COSIGNER);
    expect(submissionHash(tx.toXDR(), PASSPHRASE)).toBe(before);
  });

  test("any change to the transaction other than signatures changes the hash", () => {
    const base = submissionHash(merge().toXDR(), PASSPHRASE);
    expect(submissionHash(merge("101").toXDR(), PASSPHRASE)).not.toBe(base);
  });

  test("another network's passphrase gives another hash", () => {
    const xdr = merge().toXDR();
    expect(submissionHash(xdr, Networks.PUBLIC)).not.toBe(submissionHash(xdr, PASSPHRASE));
  });

  test("a sponsored envelope hashes to the outer hash, never the inner one", () => {
    const inner = merge();
    inner.sign(SOURCE);
    const wrapped = sponsored(inner);
    const hash = submissionHash(wrapped.toXDR(), PASSPHRASE);
    expect(hash).toBe(toHex(wrapped.hash()));
    expect(hash).not.toBe(toHex(inner.hash()));
  });

  test("a sponsor re-wrapping with another fee gives another hash, so the close stays unknown", () => {
    const inner = merge();
    inner.sign(SOURCE);
    const other = TransactionBuilder.buildFeeBumpTransaction(SPONSOR, "300", inner, PASSPHRASE);
    expect(submissionHash(other.toXDR(), PASSPHRASE)).not.toBe(
      submissionHash(sponsored(inner).toXDR(), PASSPHRASE)
    );
  });

  test("a co-signature on the inner transaction leaves its hash but moves the outer one", () => {
    const inner = merge();
    inner.sign(SOURCE);
    const innerHash = toHex(inner.hash());
    const before = submissionHash(sponsored(inner).toXDR(), PASSPHRASE);
    inner.sign(COSIGNER);
    expect(toHex(inner.hash())).toBe(innerHash);
    expect(submissionHash(sponsored(inner).toXDR(), PASSPHRASE)).not.toBe(before);
  });
});

describe("submissionValidUntil", () => {
  test("reads the upper time bound", () => {
    const tx = merge();
    expect(submissionValidUntil(tx.toXDR(), PASSPHRASE)).toBe(Number(tx.timeBounds!.maxTime));
  });

  test("reads the inner bound of a sponsored envelope", () => {
    const inner = merge();
    inner.sign(SOURCE);
    expect(submissionValidUntil(sponsored(inner).toXDR(), PASSPHRASE)).toBe(
      Number(inner.timeBounds!.maxTime)
    );
  });

  test("is null with no upper bound", () => {
    expect(submissionValidUntil(merge("100", 0).toXDR(), PASSPHRASE)).toBeNull();
  });
});

describe("mergesAccount", () => {
  test("finds a merge of the account, plain and sponsored", () => {
    const inner = merge();
    inner.sign(SOURCE);
    expect(mergesAccount(inner.toXDR(), PASSPHRASE, SOURCE.publicKey())).toBe(true);
    expect(mergesAccount(sponsored(inner).toXDR(), PASSPHRASE, SOURCE.publicKey())).toBe(true);
  });

  test("a merge of another account does not count", () => {
    expect(mergesAccount(merge().toXDR(), PASSPHRASE, COSIGNER.publicKey())).toBe(false);
  });

  test("a transaction with no merge does not count", () => {
    const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "100"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.manageData({ name: "a", value: null }))
      .setTimeout(300)
      .build();
    expect(mergesAccount(tx.toXDR(), PASSPHRASE, SOURCE.publicKey())).toBe(false);
  });
});
