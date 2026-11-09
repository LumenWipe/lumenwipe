import { expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { CloseController } from "@/close/close.controller";
import { CloseService } from "@/close/close.service";
import {
  defaultClock,
  defaultCloseBuilder,
  defaultCloseReader,
  defaultExchangeRegistry,
  submitterFor,
} from "@/common/ports";
import { checkTransactionSignatures, InvalidSignatureError } from "@/lib/stellar/signature";
import { submitAndWait } from "@/lib/stellar/submit";
import type { StatsService } from "@/stats/stats.service";

const SOURCE = Keypair.random();
const OTHER = Keypair.random();

function unsigned(): Transaction {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
}

/** A signature that names the source account's key (its hint) but was made by another key. */
function withForgedHint(): Transaction {
  const tx = unsigned();
  tx.signatures.push(
    new xdr.DecoratedSignature({ hint: SOURCE.signatureHint(), signature: OTHER.sign(tx.hash()) })
  );
  return tx;
}

/** The source account's own signature with one byte changed. */
function withCorruptedSignature(): Transaction {
  const tx = unsigned();
  const signature = Buffer.from(SOURCE.sign(tx.hash()));
  signature[0] = signature[0]! ^ 0xff;
  tx.signatures.push(new xdr.DecoratedSignature({ hint: SOURCE.signatureHint(), signature }));
  return tx;
}

function serverSending(answer: unknown): { server: rpc.Server; sends: () => number } {
  let sends = 0;
  let reads = 0;
  const server = {
    // The first read is the pre-send history check; every later one is the confirmation poll.
    getTransaction: async () =>
      reads++ === 0 ? { status: "NOT_FOUND" } : { status: "SUCCESS", ledger: 9 },
    sendTransaction: async () => {
      sends++;
      return answer;
    },
  } as unknown as rpc.Server;
  return { server, sends: () => sends };
}

const pending = { status: "PENDING" };

function controllerOn(server: rpc.Server): CloseController {
  return new CloseController(
    new CloseService(
      { recordClose: async () => {} } as unknown as StatsService,
      defaultCloseReader,
      defaultCloseBuilder,
      submitterFor(() => server),
      defaultExchangeRegistry,
      defaultClock
    )
  );
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; error: unknown }> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof HttpException) {
      return { status: e.getStatus(), error: (e.getResponse() as { error: unknown }).error };
    }
    throw e;
  }
  throw new Error("expected submit to reject");
}

test("an envelope with no signatures is not refused offline: a pre-authorized transaction carries none", () => {
  expect(() => checkTransactionSignatures(unsigned())).not.toThrow();
});

test("an envelope with no signatures is sent to the network, which decides", async () => {
  const { server, sends } = serverSending(pending);
  const result = await submitAndWait(unsigned().toXDR(), "testnet", undefined, () => server);
  expect(sends()).toBe(1);
  expect(result.ledger).toBe(9);
});

test("a signature that names the source key but was made by another key is refused", () => {
  expect(() => checkTransactionSignatures(withForgedHint())).toThrow(InvalidSignatureError);
});

test("a corrupted signature from the source key is refused", () => {
  expect(() => checkTransactionSignatures(withCorruptedSignature())).toThrow(InvalidSignatureError);
});

test("a valid signature from the source key passes", () => {
  const tx = unsigned();
  tx.sign(SOURCE);
  expect(() => checkTransactionSignatures(tx)).not.toThrow();
});

test("a signature from a key that is not the source is left to the network as a co-signer", () => {
  const tx = unsigned();
  tx.sign(OTHER);
  expect(() => checkTransactionSignatures(tx)).not.toThrow();
});

test("close/submit refuses a signature that names the source key but does not verify, and sends nothing", async () => {
  const { server, sends } = serverSending(pending);
  expect(
    await rejection(controllerOn(server).submit("testnet", { signedXdr: withForgedHint().toXDR() }))
  ).toEqual({
    status: 400,
    error: { code: "invalid_signature", message: "The transaction is missing a valid signature." },
  });
  expect(sends()).toBe(0);
});

test("close/submit answers an envelope the network refuses for signing weight with a plain-language 422", async () => {
  const badAuth = {
    status: "ERROR",
    errorResult: new xdr.TransactionResult({
      feeCharged: 100n,
      result: xdr.TransactionResultResult.txBadAuth(),
      ext: xdr.TransactionResultExt.v0(),
    }),
  };
  const { server, sends } = serverSending(badAuth);
  expect(
    await rejection(controllerOn(server).submit("testnet", { signedXdr: unsigned().toXDR() }))
  ).toEqual({
    status: 422,
    error: {
      code: "submit_rejected",
      message:
        "The signatures on this transaction do not reach the signing weight the account requires. Check that every required signer signed it, or that a pasted pre-authorized transaction is the exact one the account authorized.",
      details: { resultCode: "tx_bad_auth" },
    },
  });
  expect(sends()).toBe(1);
});
