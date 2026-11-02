import { describe, expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { POLL_INTERVAL_MS, SETTLE_WINDOW_MS, SUBMIT_BUDGET_MS } from "@/config/constants";
import { submitAndWait, type SubmitClock } from "@/lib/stellar/submit";
import { TxPendingError, TxSubmitError, TxUnsettledError } from "@/lib/utils/errors";

const SOURCE = Keypair.random();

function envelope(): { signed: string; hash: string } {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return { signed: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

function fakeClock(): SubmitClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

const RESULTS: Record<string, () => xdr.TransactionResultResult> = {
  txBadSeq: () => xdr.TransactionResultResult.txBadSeq(),
  txNoAccount: () => xdr.TransactionResultResult.txNoAccount(),
  txTooLate: () => xdr.TransactionResultResult.txTooLate(),
  txInsufficientFee: () => xdr.TransactionResultResult.txInsufficientFee(),
  txFeeBumpInnerFailed: () =>
    xdr.TransactionResultResult.txFeeBumpInnerFailed(
      new xdr.InnerTransactionResultPair({
        transactionHash: new xdr.Hash(Buffer.alloc(32)),
        result: new xdr.InnerTransactionResult({
          feeCharged: 100n,
          result: xdr.InnerTransactionResultResult.txBadSeq(),
          ext: xdr.InnerTransactionResultExt.v0(),
        }),
      })
    ),
};

function rejected(type: string): rpc.Api.SendTransactionResponse {
  const errorResult = new xdr.TransactionResult({
    feeCharged: 100n,
    result: RESULTS[type]!(),
    ext: xdr.TransactionResultExt.v0(),
  });
  return { status: "ERROR", errorResult } as unknown as rpc.Api.SendTransactionResponse;
}

const pending = { status: "PENDING" } as rpc.Api.SendTransactionResponse;
const notFound = { status: "NOT_FOUND" };
const success = { status: "SUCCESS", ledger: 77 };

interface Script {
  /** Answers in order; the last repeats. A thrown value is rethrown. */
  reads: unknown[];
  sends: unknown[];
}

function stub({ reads, sends }: Script) {
  const counts = { reads: 0, sends: 0 };
  const take = <T>(list: T[], i: number): T => list[Math.min(i, list.length - 1)]!;
  const server = {
    getTransaction: async () => {
      const answer = take(reads, counts.reads++);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sendTransaction: async () => {
      const answer = take(sends, counts.sends++);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as rpc.Server;
  return { server, counts };
}

const run = (script: Script, clock = fakeClock(), next: rpc.Server | null = null) => {
  const { server, counts } = stub(script);
  const result = submitAndWait(
    envelope().signed,
    "testnet",
    undefined,
    () => server,
    () => next,
    clock
  );
  return { result, counts, clock };
};

describe("an answer short of acceptance is settled by hash", () => {
  test("NOT_FOUND, then ERROR(tx_bad_seq), then SUCCESS by hash is a success", async () => {
    const { result, counts } = run({
      reads: [notFound, success],
      sends: [rejected("txBadSeq")],
    });
    expect((await result).ledger).toBe(77);
    expect(counts.sends).toBe(1);
  });

  test("ERROR(tx_no_account) from re-sending a merge that landed is a success", async () => {
    const { result } = run({
      reads: [notFound, notFound, success],
      sends: [rejected("txNoAccount")],
    });
    expect((await result).ledger).toBe(77);
  });

  test("tx_too_late and an inner fee-bump failure are read by hash too", async () => {
    for (const type of ["txTooLate", "txFeeBumpInnerFailed"]) {
      const { result } = run({ reads: [notFound, success], sends: [rejected(type)] });
      expect((await result).ledger).toBe(77);
    }
  });

  test("a rejection that cannot mean the transaction landed is not read by hash", async () => {
    const { result, counts } = run({
      reads: [notFound, success],
      sends: [rejected("txInsufficientFee")],
    });
    await expect(result).rejects.toBeInstanceOf(TxSubmitError);
    expect(counts.reads).toBe(1);
  });

  test("the original rejection stands when the window shows nothing", async () => {
    const { result, clock } = run({ reads: [notFound], sends: [rejected("txBadSeq")] });
    await expect(result).rejects.toMatchObject({ resultCode: "tx_bad_seq" });
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SETTLE_WINDOW_MS);
  });

  test("a thrown send followed by SUCCESS by hash is a success, sent once", async () => {
    const { result, counts } = run({
      reads: [notFound, success],
      sends: [new Error("socket hang up")],
    });
    expect((await result).ledger).toBe(77);
    expect(counts.sends).toBe(1);
  });

  test("a thrown send with nothing on the ledger is retryable and names the hash", async () => {
    const { result, counts } = run({ reads: [notFound], sends: [new Error("socket hang up")] });
    const failure = await result.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TxUnsettledError);
    expect((failure as TxUnsettledError).txHash).toHaveLength(64);
    expect(counts.sends).toBe(1);
  });

  test("a by-hash read that fails after a thrown send leaves the outcome unsettled", async () => {
    const { result } = run({
      reads: [notFound, new Error("rpc down")],
      sends: [new Error("socket hang up")],
    });
    await expect(result).rejects.toBeInstanceOf(TxUnsettledError);
  });

  test("the next provider gets exactly one by-hash read and no send", async () => {
    const next = stub({ reads: [success], sends: [new Error("must not send")] });
    const { result, counts } = run(
      { reads: [notFound], sends: [new Error("socket hang up")] },
      fakeClock(),
      next.server
    );
    expect((await result).ledger).toBe(77);
    expect(next.counts).toEqual({ reads: 1, sends: 0 });
    expect(counts.sends).toBe(1);
  });

  test("TRY_AGAIN_LATER, what re-sending a confirmed transaction answers, reads by hash", async () => {
    const { result, counts } = run({
      reads: [notFound, success],
      sends: [{ status: "TRY_AGAIN_LATER" }],
    });
    expect((await result).ledger).toBe(77);
    expect(counts.sends).toBe(3);
  });

  test("TRY_AGAIN_LATER with nothing on the ledger stays an unsettled, retryable failure", async () => {
    const { result } = run({ reads: [notFound], sends: [{ status: "TRY_AGAIN_LATER" }] });
    await expect(result).rejects.toBeInstanceOf(TxUnsettledError);
  });
});

describe("the pre-check", () => {
  test("a confirmed transaction is reported without a send", async () => {
    const { result, counts } = run({ reads: [success], sends: [new Error("must not send")] });
    expect((await result).ledger).toBe(77);
    expect(counts.sends).toBe(0);
  });

  test("a transaction that failed on the ledger is reported without a send", async () => {
    const { result, counts } = run({
      reads: [{ status: "FAILED" }],
      sends: [new Error("must not send")],
    });
    await expect(result).rejects.toBeInstanceOf(TxSubmitError);
    expect(counts.sends).toBe(0);
  });
});

describe("the budget", () => {
  test("polling that does not conclude is pending with the envelope's hash", async () => {
    const { signed, hash } = envelope();
    const { server, counts } = stub({ reads: [notFound], sends: [pending] });
    const clock = fakeClock();
    const failure = await submitAndWait(
      signed,
      "testnet",
      undefined,
      () => server,
      () => null,
      clock
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TxPendingError);
    expect((failure as TxPendingError).txHash).toBe(hash);
    expect(clock.now()).toBeLessThan(SUBMIT_BUDGET_MS);
    expect(counts.reads).toBeLessThanOrEqual(1 + Math.ceil(SUBMIT_BUDGET_MS / POLL_INTERVAL_MS));
  });

  test("a poll read that fails is not a failure: polling goes on to the verdict", async () => {
    const { result } = run({
      reads: [notFound, new Error("rpc down"), notFound, success],
      sends: [pending],
    });
    expect((await result).ledger).toBe(77);
  });

  test("a failed verdict while polling is a rejection", async () => {
    const { result } = run({ reads: [notFound, { status: "FAILED" }], sends: [pending] });
    await expect(result).rejects.toBeInstanceOf(TxSubmitError);
  });

  test("a send that outlives the budget is awaited, then answered as pending", async () => {
    const clock = fakeClock();
    let finished = false;
    const server = {
      getTransaction: async () => notFound,
      sendTransaction: async () => {
        await clock.sleep(SUBMIT_BUDGET_MS + 1_000);
        finished = true;
        return pending;
      },
    } as unknown as rpc.Server;
    await expect(
      submitAndWait(
        envelope().signed,
        "testnet",
        undefined,
        () => server,
        () => null,
        clock
      )
    ).rejects.toBeInstanceOf(TxPendingError);
    expect(finished).toBe(true);
  });

  test("no retry after TRY_AGAIN_LATER starts unless a full send still fits the budget", async () => {
    const clock = fakeClock();
    const script: Script = { reads: [notFound], sends: [{ status: "TRY_AGAIN_LATER" }] };
    const { server, counts } = stub(script);
    const slowFirstRead = {
      getTransaction: async () => {
        await clock.sleep(SUBMIT_BUDGET_MS - 12_000);
        return server.getTransaction("");
      },
      sendTransaction: server.sendTransaction.bind(server),
    } as unknown as rpc.Server;
    await expect(
      submitAndWait(
        envelope().signed,
        "testnet",
        undefined,
        () => slowFirstRead,
        () => null,
        clock
      )
    ).rejects.toBeInstanceOf(TxUnsettledError);
    expect(counts.sends).toBe(1);
  });
});
