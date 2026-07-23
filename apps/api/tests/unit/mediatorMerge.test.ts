import { test, expect } from "bun:test";
import {
  Account,
  Keypair,
  TransactionBuilder,
  Transaction,
  Networks,
  Operation,
} from "@stellar/stellar-sdk";
import { buildMediatorMergePaymentTx } from "@/lib/stellar/tx-builder/merge";

const USER = Keypair.random().publicKey();
const MEDIATOR = Keypair.random().publicKey();
const EXCHANGE = Keypair.random().publicKey();

test("mediator merge tx merges to the mediator and forwards the balance to the destination", () => {
  const xdr = buildMediatorMergePaymentTx(
    new Account(USER, "100"),
    MEDIATOR,
    EXCHANGE,
    "50.0000000",
    "deposit-123",
    "testnet",
    "text"
  );
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

  expect(tx.operations).toHaveLength(2);

  const merge = tx.operations[0] as Operation.AccountMerge;
  expect(merge.type).toBe("accountMerge");
  expect(merge.destination).toBe(MEDIATOR);

  const payment = tx.operations[1] as Operation.Payment;
  expect(payment.type).toBe("payment");
  expect(payment.source).toBe(MEDIATOR);
  expect(payment.destination).toBe(EXCHANGE);
  expect(payment.asset.isNative()).toBe(true);
  // The forwarded amount is the balance minus a small (2-op) fee buffer, never more.
  expect(Number(payment.amount)).toBeGreaterThan(49.9);
  expect(Number(payment.amount)).toBeLessThan(50);

  // The deposit memo rides the forwarding transaction.
  expect(tx.memo.value?.toString()).toBe("deposit-123");
});
