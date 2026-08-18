import { test, expect } from "bun:test";
import { Account, Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildMediatorMergePaymentTx, buildMergeTx } from "@/lib/stellar/tx-builder/merge";
import { BASE_FEE_STROOPS } from "@/config/constants";

const USER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MEDIATOR = Keypair.random().publicKey();

test("buildMergeTx > a single accountMerge op at the base fee, no memo by default", () => {
  const account = new Account(USER, "100");
  const xdr = buildMergeTx(account, DEST, null, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]!.type).toBe("accountMerge");
  expect((tx.operations[0] as { destination: string }).destination).toBe(DEST);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
  expect(tx.memo.type).toBe("none");
});

test("buildMergeTx > attaches a text memo when the type is omitted (default branch)", () => {
  const account = new Account(USER, "100");
  const xdr = buildMergeTx(account, DEST, "hello", "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.memo.type).toBe("text");
  expect(tx.memo.value?.toString()).toBe("hello");
});

test("buildMergeTx > attaches an id memo when memoType is 'id'", () => {
  const account = new Account(USER, "100");
  const xdr = buildMergeTx(account, DEST, "12345", "testnet", "id");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.memo.type).toBe("id");
  expect(tx.memo.value?.toString()).toBe("12345");
});

test("buildMergeTx > an empty-string memo is treated as no memo (falsy guard)", () => {
  const account = new Account(USER, "100");
  const xdr = buildMergeTx(account, DEST, "", "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.memo.type).toBe("none");
});

test("buildMediatorMergePaymentTx > an id memoType attaches an id memo instead of text", () => {
  const account = new Account(USER, "100");
  const xdr = buildMediatorMergePaymentTx(
    account,
    MEDIATOR,
    DEST,
    "50.0000000",
    "999",
    "testnet",
    "id"
  );

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.memo.type).toBe("id");
  expect(tx.memo.value?.toString()).toBe("999");
});

test("buildMediatorMergePaymentTx > no memo when none is given", () => {
  const account = new Account(USER, "100");
  const xdr = buildMediatorMergePaymentTx(account, MEDIATOR, DEST, "50.0000000", null, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  expect(tx.memo.type).toBe("none");
});

test("buildMediatorMergePaymentTx > forwards exactly the balance minus the two-operation fee buffer", () => {
  const account = new Account(USER, "100");
  const xdr = buildMediatorMergePaymentTx(account, MEDIATOR, DEST, "50.0000000", null, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  const payment = tx.operations[1] as { amount: string };
  const feeBufferXlm = (2 * BASE_FEE_STROOPS) / 10_000_000;
  expect(Number(payment.amount)).toBeCloseTo(50 - feeBufferXlm, 7);
});
