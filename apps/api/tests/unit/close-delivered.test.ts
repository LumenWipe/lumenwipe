import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import {
  DeliveredReadError,
  readDelivered,
  type HorizonTransactionReader,
  type HorizonTransactionRecord,
} from "@/lib/close-api/delivered-amount";

const SOURCE = Keypair.random();
const RELAY = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const LEDGER = 4242;

type Built = { envelope: xdr.TransactionEnvelope; hash: string; innerHash?: string };

function build(ops: xdr.Operation[], passphrase: string = Networks.TESTNET): Built {
  const builder = new TransactionBuilder(new Account(SOURCE.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(30).build();
  tx.sign(SOURCE);
  return { envelope: tx.toEnvelope(), hash: Buffer.from(tx.hash()).toString("hex") };
}

function feeBump(inner: Built): Built {
  const innerTx = TransactionBuilder.fromXDR(inner.envelope, Networks.TESTNET);
  const sponsor = Keypair.random();
  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    "200",
    innerTx as never,
    Networks.TESTNET
  );
  bumped.sign(sponsor);
  return {
    envelope: bumped.toEnvelope(),
    hash: Buffer.from(bumped.hash()).toString("hex"),
    innerHash: inner.hash,
  };
}

const mergeInto = (destination: string) => Operation.accountMerge({ destination });
const forward = (amount: string, destination = DESTINATION, source = RELAY) =>
  Operation.payment({ source, destination, asset: Asset.native(), amount });
const pathPaymentTo = (destination: string) =>
  Operation.pathPaymentStrictSend({
    sendAsset: new Asset("USD", OTHER),
    sendAmount: "10",
    destination,
    destAsset: Asset.native(),
    destMin: "1",
  });

const mergeOk = (stroops: bigint) =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.accountMerge(xdr.AccountMergeResult.accountMergeSuccess(stroops))
  );
const mergeNoAccount = () =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.accountMerge(xdr.AccountMergeResult.accountMergeNoAccount())
  );
const bumpOk = () =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.bumpSequence(xdr.BumpSequenceResult.bumpSequenceSuccess())
  );
const paymentUnderfunded = () =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded())
  );
const paymentOk = () =>
  xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()));
const pathPaymentOk = () =>
  xdr.OperationResult.opInner(
    xdr.OperationResultTr.pathPaymentStrictSend(
      xdr.PathPaymentStrictSendResult.pathPaymentStrictSendSuccess(
        new xdr.PathPaymentStrictSendResultSuccess({
          offers: [],
          last: new xdr.SimplePaymentResult({
            destination: StrKey.decodeEd25519PublicKey(DESTINATION) as never,
            asset: xdr.Asset.assetTypeNative(),
            amount: 50_000_000n,
          }),
        })
      )
    )
  );

const success = (results: xdr.OperationResult[]) =>
  new xdr.TransactionResult({
    feeCharged: 100n,
    result: xdr.TransactionResultResult.txSuccess(results),
    ext: xdr.TransactionResultExt.v0(),
  });
const failed = (results: xdr.OperationResult[]) =>
  new xdr.TransactionResult({
    feeCharged: 100n,
    result: xdr.TransactionResultResult.txFailed(results),
    ext: xdr.TransactionResultExt.v0(),
  });
function feeBumpShape(
  innerHash: string,
  results: xdr.OperationResult[],
  ok = true
): xdr.TransactionResult {
  const inner = new xdr.InnerTransactionResult({
    feeCharged: 100n,
    result: ok
      ? xdr.InnerTransactionResultResult.txSuccess(results)
      : xdr.InnerTransactionResultResult.txFailed(results),
    ext: xdr.InnerTransactionResultExt.v0(),
  });
  const pair = new xdr.InnerTransactionResultPair({
    transactionHash: new xdr.Hash(Buffer.from(innerHash, "hex")),
    result: inner,
  });
  return new xdr.TransactionResult({
    feeCharged: 200n,
    result: ok
      ? xdr.TransactionResultResult.txFeeBumpInnerSuccess(pair)
      : xdr.TransactionResultResult.txFeeBumpInnerFailed(pair),
    ext: xdr.TransactionResultExt.v0(),
  });
}

type RpcAnswer = Awaited<ReturnType<rpc.Server["getTransaction"]>>;

const confirmed = (built: Built, result: xdr.TransactionResult): RpcAnswer =>
  ({
    status: "SUCCESS",
    ledger: LEDGER,
    envelopeXdr: built.envelope,
    resultXdr: result,
  }) as unknown as RpcAnswer;
const rejected = (built: Built, result: xdr.TransactionResult): RpcAnswer =>
  ({ ...confirmed(built, result), status: "FAILED" }) as unknown as RpcAnswer;
const NOT_FOUND = {
  status: "NOT_FOUND",
  oldestLedger: 1,
  oldestLedgerCloseTime: "1",
  latestLedger: 2,
  latestLedgerCloseTime: "2",
} as unknown as RpcAnswer;

const horizonRecord = (
  built: Built,
  result: xdr.TransactionResult,
  successful = true
): HorizonTransactionRecord => ({
  successful,
  ledger: LEDGER,
  envelope_xdr: built.envelope.toXdr("base64"),
  result_xdr: result.toXdr("base64"),
});

function rpcOf(answers: Record<string, RpcAnswer | Error>) {
  return {
    getTransaction: async (hash: string) => {
      const answer = answers[hash] ?? NOT_FOUND;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as Pick<rpc.Server, "getTransaction">;
}

const noHorizon: HorizonTransactionReader = async () => {
  throw new Error("Horizon must not be read when RPC holds the transaction");
};
const horizonOf =
  (records: Record<string, HorizonTransactionRecord | Error>): HorizonTransactionReader =>
  async (hash) => {
    const record = records[hash];
    if (record instanceof Error) throw record;
    return record ?? null;
  };

async function readOne(
  hash: string,
  rpcServer: Pick<rpc.Server, "getTransaction">,
  horizon: HorizonTransactionReader = noHorizon
) {
  return readDelivered(rpcServer, horizon, "testnet", DESTINATION, [hash]);
}

describe("readDelivered: what counts", () => {
  test("a direct close delivers the balance its merge result reports", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(123_456_789n)])) })
    );
    expect(out).toEqual({
      destination: DESTINATION,
      entries: [{ hash: tx.hash, status: "delivered", ledger: LEDGER, amountStroops: "123456789" }],
      totalStroops: "123456789",
    });
  });

  test("a relay close delivers the forward payment, not the balance merged into the relay", async () => {
    const tx = build([mergeInto(RELAY), forward("12.3456780")]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(123_456_980n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "123456780" });
    expect(out.totalStroops).toBe("123456780");
  });

  test("a merge into a muxed form of the destination counts", async () => {
    const muxed = StrKey.encodeMed25519PublicKey(
      Buffer.concat([StrKey.decodeEd25519PublicKey(DESTINATION), Buffer.alloc(8, 7)])
    );
    const tx = build([mergeInto(muxed)]);
    const out = await readOne(tx.hash, rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(5n)])) }));
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "5" });
  });

  test("a path payment to the destination beside the merge is not counted", async () => {
    const tx = build([pathPaymentTo(DESTINATION), mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([pathPaymentOk(), mergeOk(70_000_000n)])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "70000000" });
  });

  test("a payment to the destination without a merge is no_delivery", async () => {
    const tx = build([forward("10", DESTINATION, SOURCE.publicKey())]);
    const out = await readOne(tx.hash, rpcOf({ [tx.hash]: confirmed(tx, success([paymentOk()])) }));
    expect(out.entries[0]).toEqual({
      hash: tx.hash,
      status: "unavailable",
      reason: "no_delivery",
      ledger: LEDGER,
    });
    expect(out.totalStroops).toBeUndefined();
  });

  test("a merge into another account, with nothing forwarded, is no_delivery", async () => {
    const tx = build([mergeInto(OTHER)]);
    const out = await readOne(tx.hash, rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(9n)])) }));
    expect(out.entries[0]).toMatchObject({ status: "unavailable", reason: "no_delivery" });
  });

  test("a payment from an account other than the one merged into is not a forward", async () => {
    const tx = build([mergeInto(RELAY), forward("1", DESTINATION, OTHER)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(20_000_000n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });

  test("a payment before the merge into its source is not a forward", async () => {
    const tx = build([forward("1"), mergeInto(RELAY)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([paymentOk(), mergeOk(20_000_000n)])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });

  test("a forward needs its merge to have succeeded", async () => {
    const tx = build([mergeInto(RELAY), forward("1")]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeNoAccount(), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });

  test("a merge into the destination counts only when its result is a success", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeNoAccount()])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "unavailable", reason: "no_delivery" });
  });

  test("a forward counts only when its payment result is a success", async () => {
    const tx = build([mergeInto(RELAY), forward("1")]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(20_000_000n), paymentUnderfunded()])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });

  test("a forward to another account is not counted for the destination", async () => {
    const tx = build([mergeInto(RELAY), forward("1", OTHER)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(20_000_000n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });

  test("one merge is forwarded at most once", async () => {
    const tx = build([mergeInto(RELAY), forward("4"), forward("5")]);
    const out = await readOne(
      tx.hash,
      rpcOf({
        [tx.hash]: confirmed(tx, success([mergeOk(100_000_000n), paymentOk(), paymentOk()])),
      })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "40000000" });
  });

  test("a forward larger than its merge carried is no_delivery", async () => {
    const tx = build([mergeInto(RELAY), forward("10.0000001")]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(100_000_000n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "unavailable", reason: "no_delivery" });
  });

  test("a forward of exactly the merged balance counts", async () => {
    const tx = build([mergeInto(RELAY), forward("10")]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(100_000_000n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "100000000" });
  });

  test("a forward in an asset other than XLM is not counted", async () => {
    const tx = build([
      mergeInto(RELAY),
      Operation.payment({
        source: RELAY,
        destination: DESTINATION,
        asset: new Asset("USD", OTHER),
        amount: "1",
      }),
    ]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(100_000_000n), paymentOk()])) })
    );
    expect(out.entries[0]).toMatchObject({ reason: "no_delivery" });
  });
});

describe("readDelivered: outcomes", () => {
  test("a failed transaction is failed, with no amount and no total", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: rejected(tx, failed([mergeNoAccount()])) })
    );
    expect(out).toEqual({
      destination: DESTINATION,
      entries: [{ hash: tx.hash, status: "unavailable", reason: "failed", ledger: LEDGER }],
    });
  });

  test("a hash neither provider holds is not_found", async () => {
    const hash = "ab".repeat(32);
    const out = await readOne(hash, rpcOf({}), horizonOf({}));
    expect(out).toEqual({
      destination: DESTINATION,
      entries: [{ hash, status: "unavailable", reason: "not_found" }],
    });
  });

  test("past RPC's retention window the Horizon record answers", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({}),
      horizonOf({ [tx.hash]: horizonRecord(tx, success([mergeOk(31n)])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "31" });
  });

  test("a failed transaction read from Horizon is failed", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({}),
      horizonOf({ [tx.hash]: horizonRecord(tx, failed([mergeNoAccount()]), false) })
    );
    expect(out.entries[0]).toMatchObject({ status: "unavailable", reason: "failed" });
  });

  test("RPC down with Horizon answering still resolves", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const out = await readOne(
      tx.hash,
      rpcOf({ [tx.hash]: new Error("rpc down") }),
      horizonOf({ [tx.hash]: horizonRecord(tx, success([mergeOk(8n)])) })
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "8" });
  });

  test("RPC down and Horizon without the hash is a failed read, never not_found", async () => {
    const hash = "cd".repeat(32);
    await expect(
      readOne(hash, rpcOf({ [hash]: new Error("rpc down") }), horizonOf({}))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });

  test("RPC without the hash and Horizon down is a failed read", async () => {
    const hash = "ef".repeat(32);
    await expect(
      readOne(hash, rpcOf({}), horizonOf({ [hash]: new Error("horizon down") }))
    ).rejects.toThrow("horizon down");
  });

  test("an incomplete Horizon record is a failed read", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    const record = { ...horizonRecord(tx, success([mergeOk(1n)])), result_xdr: undefined };
    await expect(
      readOne(tx.hash, rpcOf({}), horizonOf({ [tx.hash]: record as never }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });

  test("a status that contradicts the result is a failed read", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    await expect(
      readOne(tx.hash, rpcOf({ [tx.hash]: confirmed(tx, failed([mergeNoAccount()])) }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });

  test("a result with a different operation count is a failed read", async () => {
    const tx = build([mergeInto(DESTINATION)]);
    await expect(
      readOne(tx.hash, rpcOf({ [tx.hash]: confirmed(tx, success([mergeOk(1n), paymentOk()])) }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });
});

describe("readDelivered: binding the answer to the hash", () => {
  test("a provider answering with another transaction is a failed read, never an amount", async () => {
    const asked = build([mergeInto(DESTINATION)]);
    const other = build([Operation.bumpSequence({ bumpTo: "7" }), mergeInto(DESTINATION)]);
    const otherResult = success([bumpOk(), mergeOk(1n)]);
    await expect(
      readOne(asked.hash, rpcOf({ [asked.hash]: confirmed(other, otherResult) }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
    await expect(
      readOne(asked.hash, rpcOf({}), horizonOf({ [asked.hash]: horizonRecord(other, otherResult) }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });

  test("an envelope signed for another network is a failed read", async () => {
    const mainnet = build([mergeInto(DESTINATION)], Networks.PUBLIC);
    await expect(
      readOne(mainnet.hash, rpcOf({ [mainnet.hash]: confirmed(mainnet, success([mergeOk(1n)])) }))
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });
});

describe("readDelivered: fee-bump", () => {
  const inner = build([mergeInto(DESTINATION)]);
  const bumped = feeBump(inner);
  const shapes = {
    "the fee-bump result": feeBumpShape(inner.hash, [mergeOk(77n)]),
    "the inner result": success([mergeOk(77n)]),
  };

  for (const [shape, result] of Object.entries(shapes)) {
    for (const [which, hash] of [
      ["outer", bumped.hash],
      ["inner", inner.hash],
    ] as const) {
      test(`looked up by the ${which} hash, with ${shape}, from RPC`, async () => {
        const out = await readOne(hash, rpcOf({ [hash]: confirmed(bumped, result) }));
        expect(out.entries[0]).toMatchObject({ hash, status: "delivered", amountStroops: "77" });
      });

      test(`looked up by the ${which} hash, with ${shape}, from Horizon`, async () => {
        const out = await readOne(
          hash,
          rpcOf({}),
          horizonOf({ [hash]: horizonRecord(bumped, result) })
        );
        expect(out.entries[0]).toMatchObject({ status: "delivered", amountStroops: "77" });
      });
    }
  }

  test("an inner transaction that failed is failed", async () => {
    const out = await readOne(
      bumped.hash,
      rpcOf({
        [bumped.hash]: rejected(bumped, feeBumpShape(inner.hash, [mergeNoAccount()], false)),
      })
    );
    expect(out.entries[0]).toMatchObject({ status: "unavailable", reason: "failed" });
  });

  test("a fee-bump result naming another inner transaction is a failed read", async () => {
    const stray = feeBumpShape("00".repeat(32), [mergeOk(77n)]);
    for (const hash of [bumped.hash, inner.hash]) {
      await expect(
        readOne(hash, rpcOf({ [hash]: confirmed(bumped, stray) }))
      ).rejects.toBeInstanceOf(DeliveredReadError);
    }
  });

  test("a fee-bump result on an envelope that is not a fee-bump is a failed read", async () => {
    await expect(
      readOne(
        inner.hash,
        rpcOf({ [inner.hash]: confirmed(inner, feeBumpShape(inner.hash, [mergeOk(77n)])) })
      )
    ).rejects.toBeInstanceOf(DeliveredReadError);
  });
});

describe("readDelivered: several hashes", () => {
  test("entries keep the order asked and the total sums past 2^53 exactly", async () => {
    const a = build([mergeInto(DESTINATION)]);
    const b = build([mergeInto(RELAY), forward("900719925.4740993")]);
    const out = await readDelivered(
      rpcOf({
        [a.hash]: confirmed(a, success([mergeOk(9_007_199_254_740_993n)])),
        [b.hash]: confirmed(b, success([mergeOk(9_007_199_254_740_993n), paymentOk()])),
      }),
      noHorizon,
      "testnet",
      DESTINATION,
      [b.hash, a.hash]
    );
    expect(out.entries.map((entry) => entry.hash)).toEqual([b.hash, a.hash]);
    expect(out.totalStroops).toBe("18014398509481986");
  });

  test("one unavailable entry removes the total", async () => {
    const a = build([mergeInto(DESTINATION)]);
    const missing = "12".repeat(32);
    const out = await readDelivered(
      rpcOf({ [a.hash]: confirmed(a, success([mergeOk(10n)])) }),
      horizonOf({}),
      "testnet",
      DESTINATION,
      [a.hash, missing]
    );
    expect(out.entries[0]).toMatchObject({ status: "delivered" });
    expect(out.entries[1]).toMatchObject({ status: "unavailable", reason: "not_found" });
    expect(out.totalStroops).toBeUndefined();
  });

  test("twenty hashes are read at most five at a time", async () => {
    const hashes = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, "0"));
    let inFlight = 0;
    let peak = 0;
    const slow = {
      getTransaction: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return NOT_FOUND;
      },
    } as Pick<rpc.Server, "getTransaction">;
    const out = await readDelivered(slow, horizonOf({}), "testnet", DESTINATION, hashes);
    expect(out.entries).toHaveLength(20);
    expect(peak).toBe(5);
  });
});
