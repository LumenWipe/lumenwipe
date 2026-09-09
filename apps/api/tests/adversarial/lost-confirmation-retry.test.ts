/**
 * Adversarial coverage: lost-confirmation retry safety (docs/architecture.md §17 and §22,
 * issue #168).
 *
 * A distinct failure mode from the account-state hostile cases covered elsewhere in this
 * directory (issue #167) - this one is about the submission/retry path itself, not what the
 * transaction contains. A transaction can confirm on-chain while the caller never sees the
 * response (network drop, client timeout). Resubmitting it blind is exactly the double-act the
 * resume flow is designed to prevent (§16).
 *
 * `submitAndWait` (apps/api/src/lib/stellar/submit.ts) previously had no such check: it called
 * `sendTransaction` unconditionally on every invocation. This suite exercises the pre-flight
 * `getTransaction` check added alongside it - the exact one §22 documents ("On retry the tool
 * checks getTransaction; if the transaction already confirmed, the step is marked complete
 * rather than resubmitted") - directly against `submitAndWait`, not through the controller.
 */
import { test, expect, spyOn, afterEach, mock } from "bun:test";
import { Account, Keypair, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import * as rpcModule from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";
import { TxSubmitError } from "@/lib/utils/errors";

const SOURCE = Keypair.random();

afterEach(() => {
  mock.restore();
});

// A minimal, validly-signed transaction - submitAndWait's offline signature pre-flight
// (checkTransactionSignatures) requires a real signature from the source account before any
// RPC stub is ever reached.
function signedXdr(): string {
  const account = new Account(SOURCE.publicKey(), "100");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "101" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx.toXDR();
}

function rpcServerStub(overrides: Partial<ReturnType<typeof rpcModule.getRpcServer>>) {
  return {
    sendTransaction: () => Promise.reject(new Error("sendTransaction should not be called")),
    pollTransaction: () => Promise.reject(new Error("pollTransaction should not be called")),
    getTransaction: () => Promise.reject(new Error("not stubbed")),
    ...overrides,
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>;
}

test("an already-confirmed transaction is detected via getTransaction and never resubmitted", async () => {
  const sendTransactionSpy = mock(() => Promise.reject(new Error("must not be called")));
  spyOn(rpcModule, "getRpcServer").mockReturnValue(
    rpcServerStub({
      getTransaction: () =>
        Promise.resolve({ status: "SUCCESS", ledger: 42 } as unknown as Awaited<
          ReturnType<ReturnType<typeof rpcModule.getRpcServer>["getTransaction"]>
        >),
      sendTransaction: sendTransactionSpy as unknown as ReturnType<
        typeof rpcModule.getRpcServer
      >["sendTransaction"],
    })
  );

  const result = await submitAndWait(signedXdr(), "testnet");

  expect(result.ledger).toBe(42);
  expect(sendTransactionSpy).not.toHaveBeenCalled();
});

test("a transaction the network has never seen proceeds through the normal send-and-poll path", async () => {
  const sendTransactionSpy = mock(() =>
    Promise.resolve({ status: "PENDING", hash: "abc" } as unknown as Awaited<
      ReturnType<ReturnType<typeof rpcModule.getRpcServer>["sendTransaction"]>
    >)
  );
  spyOn(rpcModule, "getRpcServer").mockReturnValue(
    rpcServerStub({
      getTransaction: () =>
        Promise.resolve({ status: "NOT_FOUND" } as unknown as Awaited<
          ReturnType<ReturnType<typeof rpcModule.getRpcServer>["getTransaction"]>
        >),
      sendTransaction: sendTransactionSpy as unknown as ReturnType<
        typeof rpcModule.getRpcServer
      >["sendTransaction"],
      pollTransaction: () =>
        Promise.resolve({ status: "SUCCESS", ledger: 7 } as unknown as Awaited<
          ReturnType<ReturnType<typeof rpcModule.getRpcServer>["pollTransaction"]>
        >),
    })
  );

  const result = await submitAndWait(signedXdr(), "testnet");

  expect(result.ledger).toBe(7);
  expect(sendTransactionSpy).toHaveBeenCalledTimes(1);
});

test("a transaction that genuinely failed on-chain is not swallowed as a false success", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(
    rpcServerStub({
      getTransaction: () =>
        Promise.resolve({ status: "FAILED" } as unknown as Awaited<
          ReturnType<ReturnType<typeof rpcModule.getRpcServer>["getTransaction"]>
        >),
      sendTransaction: () =>
        Promise.resolve({ status: "ERROR", hash: "abc" } as unknown as Awaited<
          ReturnType<ReturnType<typeof rpcModule.getRpcServer>["sendTransaction"]>
        >),
    })
  );

  // Only SUCCESS short-circuits; FAILED falls through to the ordinary send path, which here
  // rejects with ERROR - proving the pre-flight check does not swallow a real failure as success.
  await expect(submitAndWait(signedXdr(), "testnet")).rejects.toBeInstanceOf(TxSubmitError);
});
