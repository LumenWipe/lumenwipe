import { test, expect, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  Account,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
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

/** Mirrors HashXPreimageSigner.sign(): applies the preimage via signHashX. publicKey is the
 *  hash(x) signer's own "X..." strkey, matching how HashXPreimageInput constructs it. */
function realHashXSigner(preimage: Buffer): TransactionSigner {
  return {
    publicKey: StrKey.encodeSha256Hash(hash(preimage)),
    sign: async (xdr, networkPassphrase) => {
      const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      built.signHashX(preimage);
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

test("useCloseExecution › a hash(x) signer's preimage completes the close by resuming, same as a second wallet (#101)", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const preimage = Buffer.from("deadbeef", "hex");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));

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
        { key: hashXKey, weight: 1, type: "hash_x" },
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
  mock.module("@/lib/stellar/submit-via-api", () => ({
    submitViaApi: async () => ({ txHash: "final-hash" }),
  }));

  const { result } = renderHook(() => useCloseExecution());

  // First signer (ed25519): weight 1 of 2 required - pauses.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.accumulatedWeight).toBe(1);
  expect(result.current.signatureStatus?.remainingSigners).toEqual([
    { key: hashXKey, weight: 1, type: "hash_x" },
  ]);

  // Second signer: the hash(x) signer's validated preimage, applied the same way a second
  // wallet would be - resumes onto the same envelope, no re-fetch, and its weight counts.
  await act(async () => {
    await result.current.run(realHashXSigner(preimage));
  });

  expect(getTransactionsCalls).toBe(1); // resumed, did not re-fetch
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

// I-1: a paused signing round used to swallow a subsequent guard/generic failure with zero
// user feedback - signatureStatus stayed non-null forever, so ExecutionWizard's
// pendingMoreSignatures branch (phase === "STEP_FAILED" && signatureStatus !== null) kept
// re-rendering the identical progress panel instead of ever falling through to the branch
// that renders lastError.
test("useCloseExecution › a guard failure while paused clears signatureStatus so the UI doesn't loop the progress panel forever", async () => {
  const sourceKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = cosignerKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  // Deliberately NOT one of this account's known signers - mirrors the repro in the finding:
  // the user pastes a syntactically valid secret key that isn't actually a signer here.
  const stranger = Keypair.random().publicKey();

  const mergeXdr = unsignedMergeXdr(sourceKeypair, destination);

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  mock.module("@/lib/api/close-client", () => ({
    fetchCloseTransactions: async () => ({
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    }),
  }));

  const { result } = renderHook(() => useCloseExecution());

  // First signer: weight 1 of 2 - pauses with a real, non-null signatureStatus.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus).not.toBeNull();

  // A key that isn't a known signer on this account is presented next. This hits the
  // signer-identity guard near the top of run() - before the fix, that guard set
  // lastError/phase but never touched signatureStatus, leaving the stale paused state in
  // place forever.
  await act(async () => {
    await result.current.run(coSigner(stranger));
  });

  expect(result.current.signatureStatus).toBeNull();
  expect(useDemolishStore.getState().lastError).toMatch(
    /isn't one of this account's known signers/
  );
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
});

// I-2: on a RESUMED envelope, the old `signedTx.signatures.length === 0` guard is vacuous -
// the envelope already carries >= 1 signature before this signer even touches it. Re-signing
// with an already-contributed key still increases raw signature count (stellar-sdk's
// Transaction.sign() doesn't dedupe), so only a check that's actually about THIS signer's
// contribution (weight, which evaluateSignatureContributions dedupes by key) can catch it.
test("useCloseExecution › resigning with an already-contributed key on resume throws instead of corrupting the envelope", async () => {
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
    lastError: null,
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

  const { result } = renderHook(() => useCloseExecution());

  // First signer: weight 1 of 2 required - pauses.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.accumulatedWeight).toBe(1);
  expect(getTransactionsCalls).toBe(1);

  // The SAME key resumes and signs again - e.g. the user re-clicked "Add signature" without
  // switching wallets. Before the fix this silently appended a redundant duplicate signature
  // and paused again looking "normal"; the corruption only surfaced later as tx_bad_auth_extra
  // once a real second signer's signature pushed the total past what the network accepts.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(useDemolishStore.getState().lastError).toMatch(/didn't add a new signature/);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  // A genuine (non-weight) failure - per the I-1 fix, the resumable pending state is cleared
  // entirely rather than left pointing at a now-corrupted envelope.
  expect(result.current.signatureStatus).toBeNull();
  expect(getTransactionsCalls).toBe(1); // resumed onto the paused envelope, did not re-fetch
});

// #102: pre-auth-tx signer support. submitPreAuthTransaction bypasses the round loop entirely -
// it never calls fetchCloseTransactions - so these tests only ever mock submit-via-api, and
// deliberately drive the real verifyPreAuthTxHash/verifyCloseTransaction/intentFromXdr, exactly
// like the #101 hash(x) tests above drive the real verify()/intentFromXdr rather than mocking them.
test("useCloseExecution › submitPreAuthTransaction submits a hash-matched, intent-valid transaction directly", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const preAuthXdr = unsignedMergeXdr(sourceKeypair, destination);
  const preAuthTx = TransactionBuilder.fromXDR(preAuthXdr, Networks.TESTNET) as Transaction;
  const preAuthKey = StrKey.encodePreAuthTx(preAuthTx.hash());

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: preAuthKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  let submitCalls = 0;
  mock.module("@/lib/stellar/submit-via-api", () => ({
    submitViaApi: async () => {
      submitCalls++;
      return { txHash: "preauth-hash" };
    },
  }));

  const { result } = renderHook(() => useCloseExecution());

  await result.current.submitPreAuthTransaction(
    { key: preAuthKey, weight: 1, type: "preauth_tx" },
    preAuthXdr
  );

  expect(submitCalls).toBe(1);
});

test("useCloseExecution › submitPreAuthTransaction rejects a hash mismatch without submitting", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const preAuthXdr = unsignedMergeXdr(sourceKeypair, destination);
  // Deliberately unrelated to preAuthXdr's real hash.
  const wrongKey = StrKey.encodePreAuthTx(Buffer.alloc(32, 9));

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: wrongKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  let submitCalls = 0;
  mock.module("@/lib/stellar/submit-via-api", () => ({
    submitViaApi: async () => {
      submitCalls++;
      return { txHash: "preauth-hash" };
    },
  }));

  const { result } = renderHook(() => useCloseExecution());

  await expect(
    result.current.submitPreAuthTransaction(
      { key: wrongKey, weight: 1, type: "preauth_tx" },
      preAuthXdr
    )
  ).rejects.toThrow(/does not match/i);
  expect(submitCalls).toBe(0);
});

test("useCloseExecution › submitPreAuthTransaction rejects a transaction with an unexpected destination without submitting", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  // Hash-matches its own signer key, but merges to someone other than the user's own chosen
  // destination - exactly the hostile-pasted-XDR shape assertCloseIntent must still reject.
  const preAuthXdr = unsignedMergeXdr(sourceKeypair, attacker);
  const preAuthTx = TransactionBuilder.fromXDR(preAuthXdr, Networks.TESTNET) as Transaction;
  const preAuthKey = StrKey.encodePreAuthTx(preAuthTx.hash());

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: preAuthKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);

  let submitCalls = 0;
  mock.module("@/lib/stellar/submit-via-api", () => ({
    submitViaApi: async () => {
      submitCalls++;
      return { txHash: "preauth-hash" };
    },
  }));

  const { result } = renderHook(() => useCloseExecution());

  await expect(
    result.current.submitPreAuthTransaction(
      { key: preAuthKey, weight: 1, type: "preauth_tx" },
      preAuthXdr
    )
    // Wording changed with #116: the merge is now refused against the address the user chose
    // rather than against a configured intermediary, so the message speaks to their choice.
  ).rejects.toThrow(/did not choose/i);
  expect(submitCalls).toBe(0);
});
