import { test, expect } from "bun:test";
import {
  Keypair,
  Operation,
  TransactionBuilder,
  Account,
  Networks,
  Asset,
  xdr,
} from "@stellar/stellar-sdk";
import { verifyDemolishTransaction, PlaygroundVerificationError } from "@/lib/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";

const PASSPHRASE = Networks.TESTNET;

function buildTx(source: Keypair, ops: xdr.Operation[]): string {
  const account = new Account(source.publicKey(), "1");
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  }).setTimeout(30);
  ops.forEach((op) => builder.addOperation(op));
  return builder.build().toEnvelope().toXDR("base64");
}

/**
 * Rewrites the first operation's `destMin` to 0. The SDK's own builder refuses a zero destMin,
 * so a transaction carrying one can only be produced by XDR surgery - which is exactly the
 * shape a compromised or buggy API could still hand us, and the case the floor check exists for.
 */
function zeroOutDestMin(envelopeXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  const op = envelope.v1().tx().operations()[0]!;
  op.body().pathPaymentStrictSendOp().destMin(xdr.Int64.fromString("0"));
  return envelope.toXDR("base64");
}

function closeTx(envelopeXdr: string): CloseTransaction {
  return {
    id: "t1",
    order: 0,
    dependsOn: [],
    xdr: envelopeXdr,
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
  const tx = buildTx(demo, [Operation.accountMerge({ destination: sink.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

test("rejects a merge to any destination other than the sink", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const rogue = Keypair.random();
  const tx = buildTx(demo, [Operation.accountMerge({ destination: rogue.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(PlaygroundVerificationError);
});

test("rejects a transaction whose source is not the demo account", () => {
  const demo = Keypair.random();
  const other = Keypair.random();
  const sink = Keypair.random();
  const tx = buildTx(other, [Operation.accountMerge({ destination: sink.publicKey() })]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(PlaygroundVerificationError);
});

test("rejects an operation type outside the closing allowlist", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const tx = buildTx(demo, [
    Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: "1" }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/op_not_allowed/);
});

test("rejects setOptions that adds a signer instead of only removing one", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const tx = buildTx(demo, [
    Operation.setOptions({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 } }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/setOptions_must_only_remove_signers/);
});

test("accepts setOptions that removes a signer (weight 0)", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const forgotten = Keypair.random();
  const tx = buildTx(demo, [
    Operation.setOptions({ signer: { ed25519PublicKey: forgotten.publicKey(), weight: 0 } }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

// ─── Destination rules, matched to what the real close builder emits ──────────
//
// apps/api's tx-builder/asset-conversion.ts builds a conversion whose destination is the account
// being CLOSED (`assetConversionOp` passes `accountId`), and an unsellable-balance return whose
// destination is the asset's OWN ISSUER (`issuerPaymentOp`). Neither is ever the sink - only the
// ACCOUNT_MERGE is. These tests pin that, because the inverse (requiring the sink) rejects every
// close the real API can produce.

test("accepts a conversion path payment into the demo account itself, settling in XLM", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const tx = buildTx(demo, [
    Operation.pathPaymentStrictSend({
      sendAsset: new Asset("LWDEMO", issuer.publicKey()),
      sendAmount: "25",
      destination: demo.publicKey(),
      destAsset: Asset.native(),
      destMin: "1",
      path: [],
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

test("rejects a conversion whose proceeds leave the demo account", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const rogue = Keypair.random();
  const tx = buildTx(demo, [
    Operation.pathPaymentStrictSend({
      sendAsset: new Asset("LWDEMO", issuer.publicKey()),
      sendAmount: "25",
      destination: rogue.publicKey(),
      destAsset: Asset.native(),
      destMin: "1",
      path: [],
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/conversion_destination_not_allowed/);
});

test("rejects a conversion that does not settle in XLM", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const tx = buildTx(demo, [
    Operation.pathPaymentStrictSend({
      sendAsset: new Asset("LWDEMO", issuer.publicKey()),
      sendAmount: "25",
      destination: demo.publicKey(),
      destAsset: new Asset("RUGPULL", issuer.publicKey()),
      destMin: "1",
      path: [],
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/conversion_must_settle_in_xlm/);
});

test("rejects a conversion with no minimum-received floor", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const tx = zeroOutDestMin(
    buildTx(demo, [
      Operation.pathPaymentStrictSend({
        sendAsset: new Asset("LWDEMO", issuer.publicKey()),
        sendAmount: "25",
        destination: demo.publicKey(),
        destAsset: Asset.native(),
        destMin: "0.0000001",
        path: [],
      }),
    ])
  );
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/conversion_has_no_minimum/);
});

test("accepts a payment returning a balance to that asset's own issuer", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const tx = buildTx(demo, [
    Operation.payment({
      destination: issuer.publicKey(),
      asset: new Asset("LWDEMO", issuer.publicKey()),
      amount: "25",
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});

test("rejects a payment to an unrelated third party", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const issuer = Keypair.random();
  const rogue = Keypair.random();
  const tx = buildTx(demo, [
    Operation.payment({
      destination: rogue.publicKey(),
      asset: new Asset("LWDEMO", issuer.publicKey()),
      amount: "25",
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/payment_destination_not_allowed/);
});

// Even to the sink: the XLM balance leaves via the merge, so a native payment has no
// legitimate role. The only native payment the API ever builds is the mediated forward, which
// is sourced from the mediator and already refused by the op-source check.
test("rejects a native payment, including one to the sink", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const tx = buildTx(demo, [
    Operation.payment({ destination: sink.publicKey(), asset: Asset.native(), amount: "1" }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).toThrow(/native_payment_not_allowed/);
});

test("accepts sponsorship revocation, which decodes to per-entry-kind op types", () => {
  const demo = Keypair.random();
  const sink = Keypair.random();
  const owner = Keypair.random();
  const tx = buildTx(demo, [
    Operation.revokeAccountSponsorship({ account: owner.publicKey() }),
    Operation.revokeDataSponsorship({ account: owner.publicKey(), name: "promo_code" }),
    Operation.revokeSignerSponsorship({
      account: owner.publicKey(),
      signer: { ed25519PublicKey: Keypair.random().publicKey() },
    }),
  ]);
  expect(() =>
    verifyDemolishTransaction(closeTx(tx), {
      demoPublic: demo.publicKey(),
      sinkPublic: sink.publicKey(),
    })
  ).not.toThrow();
});
