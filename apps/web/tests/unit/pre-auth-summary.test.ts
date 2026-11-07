import { expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  type xdr,
} from "@stellar/stellar-sdk";
import { summarizeTransaction } from "@/lib/stellar/intent/describe";
import { consumesSequenceOf } from "@/lib/stellar/submission";
import { stepsCoveredBy } from "@/lib/stellar/covered-steps";

const source = Keypair.random();
const other = Keypair.random().publicKey();

function build(sequence: string, ops: xdr.Operation[], from = source.publicKey()): string {
  const builder = new TransactionBuilder(new Account(from, sequence), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(0);
  ops.forEach((op) => builder.addOperation(op));
  return builder.build().toXdr();
}

test("pre-auth summary › lists every operation in order, unrecognized ones by their raw type", () => {
  const usdc = new Asset("USDC", other);
  const xdr = new TransactionBuilder(new Account(source.publicKey(), "7"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(0)
    .addMemo(Memo.text("ref 42"))
    .addOperation(Operation.changeTrust({ asset: usdc, limit: "0" }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 0 } }))
    .addOperation(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
    .addOperation(Operation.manageData({ name: "note", value: null }))
    .addOperation(Operation.bumpSequence({ bumpTo: "100" }))
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: other }))
    .addOperation(
      Operation.payment({ destination: other, asset: usdc, amount: "2", source: other })
    )
    .addOperation(Operation.accountMerge({ destination: other }))
    .build()
    .toXdr();

  const summary = summarizeTransaction(xdr, Networks.TESTNET);

  expect(summary.source).toBe(source.publicKey());
  expect(summary.operations.map((op) => op.label)).toEqual([
    `Remove the USDC:${other} trustline`,
    `Set options: remove signer ${other}`,
    "Set options: set thresholds low 0, medium 1, high 1",
    'Delete data entry "note"',
    "Unrecognized operation (bumpSequence)",
    "Unrecognized operation (beginSponsoringFutureReserves)",
    `Pay 2.0000000 USDC:${other} to ${other}`,
    `Merge account ${source.publicKey()} into ${other}`,
  ]);
  // Nothing dropped, and each operation keeps the account it acts as.
  expect(summary.operations).toHaveLength(8);
  expect(summary.operations[6]?.source).toBe(other);
  expect(summary.mergeDestination).toBe(other);
  expect(summary.memo).toEqual({ label: "text", value: "ref 42", bytes: 6 });
});

test("pre-auth summary › a transaction with no merge and no memo says so", () => {
  const summary = summarizeTransaction(
    build("7", [Operation.manageData({ name: "a", value: "b" })]),
    Networks.TESTNET
  );
  expect(summary.operations.map((op) => op.label)).toEqual(['Set data entry "a"']);
  expect(summary.mergeDestination).toBeNull();
  expect(summary.memo).toEqual({ label: "none", value: null, bytes: null });
});

test("pre-auth summary › an envelope that cannot be read throws", () => {
  expect(() => summarizeTransaction("AAAAAgAAAAA=", Networks.TESTNET)).toThrow();
});

test("sequence used up › the same source at the round's sequence or later uses it up", () => {
  const pending = build("100", [Operation.accountMerge({ destination: other })]);
  // Account "100" builds sequence 101.
  expect(
    consumesSequenceOf(
      build("100", [Operation.bumpSequence({ bumpTo: "0" })]),
      pending,
      Networks.TESTNET
    )
  ).toBe(true);
  expect(
    consumesSequenceOf(
      build("105", [Operation.bumpSequence({ bumpTo: "0" })]),
      pending,
      Networks.TESTNET
    )
  ).toBe(true);
});

test("sequence used up › an earlier sequence or another source leaves the round", () => {
  const pending = build("100", [Operation.accountMerge({ destination: other })]);
  expect(
    consumesSequenceOf(
      build("99", [Operation.bumpSequence({ bumpTo: "0" })]),
      pending,
      Networks.TESTNET
    )
  ).toBe(false);
  expect(
    consumesSequenceOf(
      build("500", [Operation.bumpSequence({ bumpTo: "0" })], other),
      pending,
      Networks.TESTNET
    )
  ).toBe(false);
});

test("sequence used up › when either envelope cannot be read, the round is kept", () => {
  const pending = build("100", [Operation.accountMerge({ destination: other })]);
  const later = build("200", [Operation.bumpSequence({ bumpTo: "0" })]);
  expect(consumesSequenceOf("not xdr", pending, Networks.TESTNET)).toBe(false);
  expect(consumesSequenceOf(later, "not xdr", Networks.TESTNET)).toBe(false);
});

test("sequence used up › a fee-bumped pre-authorized transaction is read by its inner one", () => {
  const pending = build("100", [Operation.accountMerge({ destination: other })]);
  const inner = TransactionBuilder.fromXdr(
    build("100", [Operation.bumpSequence({ bumpTo: "0" })]),
    Networks.TESTNET
  );
  const feeSource = Keypair.random();
  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    "200",
    inner as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2],
    Networks.TESTNET
  ).toXDR();
  expect(consumesSequenceOf(bumped, pending, Networks.TESTNET)).toBe(true);
});

const token = StrKey.encodeContract(Buffer.alloc(32, 7));

function contractCall(fn: string, args: xdr.ScVal[]): string {
  return build("7", [Operation.invokeContractFunction({ contract: token, function: fn, args })]);
}

test("pre-auth summary › a token transfer reads with both addresses in full and the amount grouped", () => {
  const summary = summarizeTransaction(
    contractCall("transfer", [
      nativeToScVal(source.publicKey(), { type: "address" }),
      nativeToScVal(other, { type: "address" }),
      nativeToScVal(BigInt(12_345_670), { type: "i128" }),
    ]),
    Networks.TESTNET
  );
  expect(summary.operations[0]?.label).toBe(
    `Call transfer on contract ${token}: from ${source.publicKey()} to ${other}, amount 12,345,670 in the token's smallest unit`
  );
});

test("pre-auth summary › a token approve reads with its spender, amount and expiry", () => {
  const summary = summarizeTransaction(
    contractCall("approve", [
      nativeToScVal(source.publicKey(), { type: "address" }),
      nativeToScVal(other, { type: "address" }),
      nativeToScVal(BigInt(0), { type: "i128" }),
      nativeToScVal(500, { type: "u32" }),
    ]),
    Networks.TESTNET
  );
  expect(summary.operations[0]?.label).toBe(
    `Call approve on contract ${token}: from ${source.publicKey()} for spender ${other}, amount 0 in the token's smallest unit, until ledger 500`
  );
});

test("pre-auth summary › any other call lists every argument with its type", () => {
  const summary = summarizeTransaction(
    contractCall("withdraw", [
      nativeToScVal(source.publicKey(), { type: "address" }),
      nativeToScVal(5, { type: "u32" }),
      nativeToScVal("all", { type: "symbol" }),
    ]),
    Networks.TESTNET
  );
  expect(summary.operations[0]?.label).toBe(
    `Call withdraw on contract ${token}: arguments address ${source.publicKey()}; u32 5; symbol all`
  );
});

test("pre-auth summary › a transfer of another shape is not read as a transfer", () => {
  const summary = summarizeTransaction(
    contractCall("transfer", [
      nativeToScVal(source.publicKey(), { type: "address" }),
      nativeToScVal(5, { type: "u32" }),
    ]),
    Networks.TESTNET
  );
  expect(summary.operations[0]?.label).toBe(
    `Call transfer on contract ${token}: arguments address ${source.publicKey()}; u32 5`
  );
});

test("pre-auth summary › the fee, sequence and validity window are listed", () => {
  const xdrWindow = new TransactionBuilder(new Account(source.publicKey(), "9"), {
    fee: "250",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 1_800_000_000, maxTime: 1_800_000_600 },
  })
    .addOperation(Operation.manageData({ name: "a", value: null }))
    .build()
    .toXdr();
  const summary = summarizeTransaction(xdrWindow, Networks.TESTNET);
  expect(summary.feeXlm).toBe("0.0000250");
  expect(summary.sequence).toBe("10");
  expect(summary.validity).toBe("from 2027-01-15 08:00:00 UTC until 2027-01-15 08:10:00 UTC");
});

test("covered steps › each operation maps to its step, assets and contracts by target, once", () => {
  const usdc = new Asset("USDC", other);
  const steps = stepsCoveredBy(
    build("7", [
      Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 0 } }),
      Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }),
      Operation.manageData({ name: "a", value: null }),
      Operation.manageSellOffer({
        selling: usdc,
        buying: Asset.native(),
        amount: "0",
        price: "1",
        offerId: "5",
      }),
      Operation.changeTrust({ asset: usdc, limit: "0" }),
      Operation.payment({ destination: other, asset: usdc, amount: "1" }),
      Operation.payment({ destination: other, asset: Asset.native(), amount: "1" }),
      Operation.invokeContractFunction({ contract: token, function: "transfer", args: [] }),
      Operation.bumpSequence({ bumpTo: "0" }),
      Operation.accountMerge({ destination: other }),
    ]),
    Networks.TESTNET,
    source.publicKey()
  );
  expect(steps).toEqual([
    { type: "NORMALIZE_SIGNERS" },
    { type: "REMOVE_DATA_ENTRIES" },
    { type: "CANCEL_OFFERS" },
    { type: "REMOVE_TRUSTLINES" },
    { type: "HANDLE_ASSETS", target: `USDC:${other}` },
    { type: "EXIT_POSITIONS", target: token },
    { type: "HANDLE_ASSETS", target: token },
    { type: "MERGE" },
    { type: "CLOSE_ACCOUNT" },
  ]);
});

test("covered steps › a merge of another account closes nothing here", () => {
  const steps = stepsCoveredBy(
    build("7", [Operation.accountMerge({ destination: source.publicKey(), source: other })]),
    Networks.TESTNET,
    source.publicKey()
  );
  expect(steps).toEqual([]);
});

test("pre-auth summary › a transfer with an extra argument is not read as a token transfer", () => {
  const summary = summarizeTransaction(
    contractCall("transfer", [
      nativeToScVal(source.publicKey(), { type: "address" }),
      nativeToScVal(other, { type: "address" }),
      nativeToScVal(BigInt(10), { type: "i128" }),
      nativeToScVal(1, { type: "u32" }),
    ]),
    Networks.TESTNET
  );
  expect(summary.operations[0]?.label).toBe(
    `Call transfer on contract ${token}: arguments address ${source.publicKey()}; address ${other}; i128 10; u32 1`
  );
});
