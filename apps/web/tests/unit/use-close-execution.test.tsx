import { test, expect, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { TransactionSigner } from "@/lib/stellar/signer";

// Deviation from the plan (recorded in the SDD ledger's preflight ruling): the plan's test
// text calls run() with no mock of fetchCloseTransactions. Once the signer-identity guard
// below is fixed, run() falls through into this call - without a mock that's a real,
// unmocked network fetch(), which is flaky/slow/CI-hostile in a unit test. Mock it to reject
// immediately with a benign error so the test stays deterministic; this doesn't change what
// the test asserts (still only the "doesn't match the account" rejection string is gone).
mock.module("@/lib/api/close-client", () => ({
  fetchCloseTransactions: async () => {
    throw new Error("not mocked in this test");
  },
}));

function coSigner(publicKey: string): TransactionSigner {
  return { publicKey, sign: async (xdr) => xdr };
}

/** A real unsigned account_merge envelope - account_merge is threshold category "high" in
 *  thresholds.ts, so it drives the real requiredSignatureWeight/evaluateSignatureContributions
 *  logic in the resume test below, instead of a placeholder string those functions can't parse. */
function unsignedMergeXdr(sourceKeypair: Keypair, destination: string): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.accountMerge({ destination }));
  return builder.build().toXDR();
}

/** Mirrors SecretKeySigner.sign(): parses the given xdr, appends this keypair's signature, and
 *  re-serializes - so a second call onto an already-signed xdr appends rather than replaces. */
function realSigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (xdr, networkPassphrase) => {
      const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      built.sign(keypair);
      return built.toEnvelope().toXDR("base64");
    },
  };
}

test("useCloseExecution › accepts a co-signer whose key differs from sourceAddress", async () => {
  const source = Keypair.random().publicKey();
  const cosignerKey = Keypair.random().publicKey();

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: cosignerKey, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(coSigner(cosignerKey));
  });

  // Today this fails closed with "doesn't match the account being closed" before ever
  // reaching the fetch/verify/sign pipeline - assert that specific rejection is gone.
  expect(useDemolishStore.getState().lastError).not.toMatch(/doesn't match the account/);
});

test("useCloseExecution › a second signer completes the close by resuming, not restarting", async () => {
  const sourceKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = cosignerKeypair.publicKey();
  const destination = Keypair.random().publicKey();

  const mergeXdr = unsignedMergeXdr(sourceKeypair, destination);

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  let getTransactionsCalls = 0;
  mock.module("@/lib/api/close-client", () => ({
    fetchCloseTransactions: async () => {
      getTransactionsCalls++;
      return {
        planHash: "h",
        status: "ready",
        transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
        remaining: { steps: 0, requiresAnotherCall: false },
      };
    },
  }));
  // Deliberately NOT mocked: @/lib/stellar/verify and @/lib/stellar/intent/serialize. Bun's
  // mock.module() replaces a module in the process-wide registry for the rest of the whole
  // `bun test` run, not just this file - mocking these two leaked a fake "always
  // account_merge" intentFromXdr into other unit test files (verify.test.ts,
  // verify-revoke-sponsorship.test.ts) that import the real implementation and depend on its
  // real decoding. The mergeXdr built above is a genuinely valid, verifiable account_merge, so
  // driving it through the real verifyCloseTransaction/intentFromXdr is both safe (no cross-
  // file pollution) and a better test (it proves the real threshold-category logic classifies
  // account_merge as "high" and requires weight 2, not a hardcoded stand-in). Only the two
  // modules that make real network calls stay mocked.
  mock.module("@/lib/stellar/submit-via-api", () => ({
    submitViaApi: async () => ({ txHash: "final-hash" }),
  }));

  const { result } = renderHook(() => useCloseExecution());

  // First signer: weight 1 of 2 required - pauses, does not restart or lose the attempt.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.accumulatedWeight).toBe(1);
  expect(result.current.signatureStatus?.requiredWeight).toBe(2);
  expect(getTransactionsCalls).toBe(1);

  // Second signer: resumes onto the same envelope - no second fetch, weight now meets 2.
  await act(async () => {
    await result.current.run(realSigner(cosignerKeypair));
  });
  expect(getTransactionsCalls).toBe(1); // still 1 - resumed, did not re-fetch
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});
