import { describe, expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { signedXdrHasAccountMerge, summarizeMerges, verifyMerge } from "@/stats/merge-verification";

const SOURCE = Keypair.random();
const DESTINATION = Keypair.random().publicKey();
const HASH = "a".repeat(64);

function envelope(ops: xdr.Operation[]): xdr.TransactionEnvelope {
  const builder = new TransactionBuilder(new Account(SOURCE.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(30).build();
  tx.sign(SOURCE);
  return tx.toEnvelope();
}

const merge = () => Operation.accountMerge({ destination: DESTINATION });
const bump = () => Operation.bumpSequence({ bumpTo: "200" });

const mergeSuccess = (stroops: string) =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.accountMerge(
      xdr.AccountMergeResult.accountMergeSuccess(xdr.Int64.fromString(stroops))
    )
  );

const bumpSuccess = () =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.bumpSequence(xdr.BumpSequenceResult.bumpSequenceSuccess())
  );

function txResult(results: xdr.OperationResult[]): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txSuccess(results),
    ext: new xdr.TransactionResultExt(0),
  });
}

function feeBumpResult(results: xdr.OperationResult[]): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("200"),
    result: xdr.TransactionResultResult.txFeeBumpInnerSuccess(
      new xdr.InnerTransactionResultPair({
        transactionHash: Buffer.alloc(32),
        result: new xdr.InnerTransactionResult({
          feeCharged: xdr.Int64.fromString("100"),
          result: xdr.InnerTransactionResultResult.txSuccess(results),
          ext: new xdr.InnerTransactionResultExt(0),
        }),
      })
    ),
    ext: new xdr.TransactionResultExt(0),
  });
}

function feeBumpEnvelope(inner: xdr.TransactionEnvelope): xdr.TransactionEnvelope {
  const innerTx = TransactionBuilder.fromXDR(inner, Networks.TESTNET);
  const sponsor = Keypair.random();
  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    "200",
    innerTx as never,
    Networks.TESTNET
  );
  bumped.sign(sponsor);
  return bumped.toEnvelope();
}

describe("summarizeMerges", () => {
  test("counts a successful merge and the balance it moved", () => {
    expect(summarizeMerges(envelope([merge()]), txResult([mergeSuccess("45000000")]))).toEqual({
      accountsClosed: 1,
      xlmStroops: "45000000",
    });
  });

  test("ignores a transaction with no merge operation", () => {
    expect(summarizeMerges(envelope([bump()]), txResult([bumpSuccess()]))).toBeNull();
  });

  test("ignores a merge whose result is not a success", () => {
    const failed = xdr.OperationResult.opInner(
      xdr.OperationResultTr.accountMerge(xdr.AccountMergeResult.accountMergeNoAccount())
    );
    expect(summarizeMerges(envelope([merge()]), txResult([failed]))).toBeNull();
  });

  test("counts every merge in one transaction and sums them past 2^53 exactly", () => {
    const result = txResult([
      bumpSuccess(),
      mergeSuccess("9007199254740993"),
      mergeSuccess("9007199254740993"),
    ]);
    expect(summarizeMerges(envelope([bump(), merge(), merge()]), result)).toEqual({
      accountsClosed: 2,
      xlmStroops: "18014398509481986",
    });
  });

  test("reads the inner transaction of a fee-bumped close", () => {
    const env = feeBumpEnvelope(envelope([merge()]));
    expect(summarizeMerges(env, feeBumpResult([mergeSuccess("12")]))).toEqual({
      accountsClosed: 1,
      xlmStroops: "12",
    });
  });
});

describe("signedXdrHasAccountMerge", () => {
  test("detects a merge in a plain and a fee-bumped envelope", () => {
    expect(signedXdrHasAccountMerge(envelope([merge()]).toXDR("base64"))).toBe(true);
    expect(signedXdrHasAccountMerge(feeBumpEnvelope(envelope([merge()])).toXDR("base64"))).toBe(
      true
    );
  });

  test("is false for a non-merge envelope and for garbage", () => {
    expect(signedXdrHasAccountMerge(envelope([bump()]).toXDR("base64"))).toBe(false);
    expect(signedXdrHasAccountMerge("not-xdr")).toBe(false);
  });
});

describe("verifyMerge", () => {
  const base = {
    txHash: HASH,
    latestLedger: 10,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
  };

  const success = (env: xdr.TransactionEnvelope, result: xdr.TransactionResult) =>
    ({
      ...base,
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 9,
      createdAt: 1_760_000_000,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: env,
      resultXdr: result,
    }) as unknown as rpc.Api.GetTransactionResponse;

  test("returns the verified close, timestamped by its ledger close time", async () => {
    const verified = await verifyMerge(HASH, "testnet", async () =>
      success(envelope([merge()]), txResult([mergeSuccess("45000000")]))
    );
    expect(verified).toEqual({
      txHash: HASH,
      accountsClosed: 1,
      xlmStroops: "45000000",
      closedAt: new Date(1_760_000_000_000),
    });
  });

  test("rejects a missing or failed transaction", async () => {
    for (const status of [
      rpc.Api.GetTransactionStatus.NOT_FOUND,
      rpc.Api.GetTransactionStatus.FAILED,
    ]) {
      const response = { ...base, status } as unknown as rpc.Api.GetTransactionResponse;
      expect(await verifyMerge(HASH, "testnet", async () => response)).toBeNull();
    }
  });

  test("rejects a confirmed transaction that merged nothing", async () => {
    const response = success(envelope([bump()]), txResult([bumpSuccess()]));
    expect(await verifyMerge(HASH, "testnet", async () => response)).toBeNull();
  });

  test("does not count on trust when the RPC errors", async () => {
    expect(
      await verifyMerge(HASH, "testnet", async () => {
        throw new Error("rpc down");
      })
    ).toBeNull();
  });
});
