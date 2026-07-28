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
import { forwardExceedsMergedBalance } from "@/mediator/mediator-validation";

const MEDIATOR = Keypair.random().publicKey();
const EXCHANGE = Keypair.random().publicKey();

// Fee for the real two-operation mediator tx: 2 * 100 stroops.
const TX_FEE_STROOPS = 200;

test("allows the exact amount the builder forwards (balance minus the 2-op fee buffer)", () => {
  // buildMediatorMergePaymentTx forwards balance - 0.00002 (200 stroops).
  expect(forwardExceedsMergedBalance("49.9999800", "50.0000000", TX_FEE_STROOPS)).toBe(false);
});

test("rejects forwarding more than the merged balance (the drain attack)", () => {
  // Merge a tiny balance, try to forward a large one out of the mediator's surplus.
  expect(forwardExceedsMergedBalance("1000.0000000", "5.0000000", TX_FEE_STROOPS)).toBe(true);
});

test("rejects forwarding the full balance without leaving the fee (would drain by the fee)", () => {
  expect(forwardExceedsMergedBalance("50.0000000", "50.0000000", TX_FEE_STROOPS)).toBe(true);
});

test("rejects a forward one stroop above the fee-adjusted balance", () => {
  // balance 50, fee 0.00002 -> max 49.9999800; 49.9999900 is over.
  expect(forwardExceedsMergedBalance("49.9999900", "50.0000000", TX_FEE_STROOPS)).toBe(true);
});

test("the boundary is exact: the delivered amount is allowed, one stroop over is rejected", () => {
  // delivered = 50 - 0.00002 (200 stroops) = 49.9999800
  expect(forwardExceedsMergedBalance("49.9999800", "50.0000000", TX_FEE_STROOPS)).toBe(false);
  expect(forwardExceedsMergedBalance("49.9999801", "50.0000000", TX_FEE_STROOPS)).toBe(true);
});

test("the real builder output is within bounds (not rejected)", () => {
  const USER = Keypair.random().publicKey();
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
  const payment = tx.operations[1] as Operation.Payment;
  expect(forwardExceedsMergedBalance(payment.amount, "50.0000000", Number(tx.fee))).toBe(false);
});

test("a tampered forward amount on the real tx is rejected", () => {
  const USER = Keypair.random().publicKey();
  const xdr = buildMediatorMergePaymentTx(
    new Account(USER, "100"),
    MEDIATOR,
    EXCHANGE,
    "5.0000000", // merged only 5 XLM
    null,
    "testnet"
  );
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  // Attacker's intent: forward far more than was merged.
  expect(forwardExceedsMergedBalance("900.0000000", "5.0000000", Number(tx.fee))).toBe(true);
});
