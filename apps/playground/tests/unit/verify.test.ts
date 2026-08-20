import { test, expect } from "bun:test";
import {
  Keypair,
  Operation,
  TransactionBuilder,
  Account,
  Networks,
  Asset,
} from "@stellar/stellar-sdk";
import { verifyDemolishTransaction, PlaygroundVerificationError } from "@/lib/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";

const PASSPHRASE = Networks.TESTNET;

function buildTx(source: Keypair, ops: ReturnType<typeof Operation.payment>[]): string {
  const account = new Account(source.publicKey(), "1");
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  }).setTimeout(30);
  ops.forEach((op) => builder.addOperation(op));
  return builder.build().toEnvelope().toXDR("base64");
}

function closeTx(xdr: string): CloseTransaction {
  return {
    id: "t1",
    order: 0,
    dependsOn: [],
    xdr,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: [],
    intent: {
      summary: "test fixture",
      source: "G...",
      fee: "100",
      memo: null,
      memoType: null,
      guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      operations: [],
    },
  };
}

test("accepts a merge from the demo account to the sink account", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const xdr = buildTx(demo, [Operation.accountMerge({ destination: sink.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

test("rejects a merge to any destination other than the sink", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const rogue = Keypair.random();
  const xdr = buildTx(demo, [Operation.accountMerge({ destination: rogue.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(PlaygroundVerificationError);
});

test("rejects a transaction whose source is not the demo account", () => {
  const demo = Keypair.random();
  const other = Keypair.random();
  const sink = Keypair.random();
  const xdr = buildTx(other, [Operation.accountMerge({ destination: sink.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(PlaygroundVerificationError);
});

test("rejects an operation type outside the closing allowlist", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const xdr = buildTx(demo, [
    Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: "1" }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/op_not_allowed/);
});

test("rejects setOptions that adds a signer instead of only removing one", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const xdr = buildTx(demo, [
    Operation.setOptions({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 } }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/setOptions_must_only_remove_signers/);
});

test("accepts setOptions that removes a signer (weight 0)", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const forgotten = Keypair.random();
  const xdr = buildTx(demo, [
    Operation.setOptions({ signer: { ed25519PublicKey: forgotten.publicKey(), weight: 0 } }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

test("rejects a payment to a destination other than the sink", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const rogue = Keypair.random();
  const xdr = buildTx(demo, [
    Operation.payment({ destination: rogue.publicKey(), asset: Asset.native(), amount: "1" }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(xdr), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/payment_destination_not_allowed/);
});
