import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  Account,
  FeeBumpTransaction,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { STATE_CHANGED_REFETCH_DELAY_MS } from "@lumenwipe/sdk";
import { PLAN_CHANGED_NOTICE, useCloseExecution } from "@/hooks/useCloseExecution";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import * as closeClient from "@/lib/api/close-client";
import * as submitViaApiModule from "@/lib/stellar/submit-via-api";
import * as feeBumpSponsorModule from "@/lib/stellar/fee-bump-sponsor";
import { ApiRequestError, closeFailureMessage } from "@/lib/utils/user-error";
import type { TransactionSigner } from "@/lib/stellar/signer";
import { fromHex } from "@/lib/stellar/hex";

/** The stand-ins return only what the hook reads, so they are typed loosely on purpose. */
function stubFetchCloseTransactions(impl: () => Promise<unknown>): void {
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation(
    impl as unknown as typeof closeClient.fetchCloseTransactions
  );
}
function stubSubmitViaApi(impl: (...args: unknown[]) => Promise<unknown>): void {
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation(
    impl as unknown as typeof submitViaApiModule.submitViaApi
  );
}
function stubFeeBumpSponsor(impl: (...args: unknown[]) => Promise<unknown>): void {
  spyOn(feeBumpSponsorModule, "requestFeeBumpSponsorship").mockImplementation(
    impl as unknown as typeof feeBumpSponsorModule.requestFeeBumpSponsorship
  );
}

// The two modules that make real network calls are patched with spyOn on the real module
// objects, never with mock.module: a process-wide module replacement leaks across test files
// depending on the order Bun runs them (it did, in CI), and mock.restore() undoes a spy
// reliably. Without a per-test override, fetching transactions rejects with a benign error, so a
// test that only exercises the signer guard never reaches a real fetch().
beforeEach(() => {
  stubFetchCloseTransactions(async () => {
    throw new Error("not mocked in this test");
  });
});
afterEach(() => {
  mock.restore();
});

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
  return builder.build().toXdr();
}

/** Same shape as unsignedMergeXdr, but fee "0" - what the API builds when it flags a chunk
 *  needsSponsoredFee: true (build-transactions.ts), since the account can't pay its own fee. */
function unsignedZeroFeeMergeXdr(sourceKeypair: Keypair, destination: string): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "0",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.accountMerge({ destination }));
  return builder.build().toXdr();
}

/** Wraps the given inner transaction xdr in a signed CAP-15 fee-bump envelope, mirroring what
 *  the real /fee-bump/sponsor endpoint returns (fee-bump.controller.ts). */
function feeBumpXdr(innerXdr: string, feeKeypair: Keypair): string {
  const inner = TransactionBuilder.fromXdr(innerXdr, Networks.TESTNET) as Transaction;
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeKeypair,
    "100",
    inner,
    Networks.TESTNET
  );
  feeBump.sign(feeKeypair);
  return feeBump.toXdr();
}

/** Mirrors SecretKeySigner.sign(): parses the given xdr, appends this keypair's signature, and
 *  re-serializes - so a second call onto an already-signed xdr appends rather than replaces. */
function realSigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (xdr, networkPassphrase) => {
      const built = TransactionBuilder.fromXdr(xdr, networkPassphrase);
      built.sign(keypair);
      return built.toEnvelope().toXdr("base64");
    },
  };
}

/** Mirrors HashXPreimageSigner.sign(): applies the preimage via signHashX. publicKey is the
 *  hash(x) signer's own "X..." strkey, matching how HashXPreimageInput constructs it. */
function realHashXSigner(preimage: Uint8Array): TransactionSigner {
  return {
    publicKey: StrKey.encodeSha256Hash(hash(preimage)),
    sign: async (xdr, networkPassphrase) => {
      const built = TransactionBuilder.fromXdr(xdr, networkPassphrase);
      built.signHashX(preimage);
      return built.toEnvelope().toXdr("base64");
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
  stubFetchCloseTransactions(async () => {
    getTransactionsCalls++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  // Deliberately NOT patched: @/lib/stellar/verify and @/lib/stellar/intent/serialize. The
  // mergeXdr built above is a genuinely valid, verifiable account_merge, so driving it through
  // the real verifyCloseTransaction/intentFromXdr is a better test (it proves the real
  // threshold-category logic classifies account_merge as "high" and requires weight 2, not a
  // hardcoded stand-in). Only the two modules that make real network calls are patched.
  stubSubmitViaApi(async () => ({
    txHash: "final-hash",
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

/** Simulates a compromised or buggy wallet extension (the shape WalletKitSigner delegates
 *  to): instead of adding a signature to the exact xdr it was handed, like realSigner does,
 *  it discards the body it was given and builds a genuinely DIFFERENT transaction - same
 *  source and sequence, but with a smuggled-in extra operation (a raised high threshold) -
 *  before signing and returning that. useCloseExecution's approvedHash check (computed from
 *  the xdr handed to sign(), before the signer touches it) must catch this: the returned
 *  envelope is not a signed version of what verify() approved, it's a signature over
 *  something else entirely. */
function tamperingSigner(
  keypair: Keypair,
  sourcePublicKey: string,
  destination: string
): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (xdr, networkPassphrase) => {
      const original = TransactionBuilder.fromXdr(xdr, networkPassphrase) as Transaction;
      // Same source account and sequence number as the approved envelope - only the
      // operation set differs - so a hash mismatch below can only be attributed to the
      // smuggled-in operation, never to sequence drift or a different source account.
      const account = new Account(
        sourcePublicKey,
        (BigInt(original.sequence) - BigInt(1)).toString()
      );
      const tampered = new TransactionBuilder(account, {
        fee: original.fee,
        networkPassphrase,
      })
        .setTimeout(300)
        .addOperation(Operation.accountMerge({ destination }))
        // The smuggled-in change: raising the high threshold was never part of what the
        // user asked to sign, nor of what verify() approved.
        .addOperation(Operation.setOptions({ highThreshold: 2 }))
        .build();
      tampered.sign(keypair);
      return tampered.toEnvelope().toXdr("base64");
    },
  };
}

test("useCloseExecution › a signer that returns a body-tampered envelope on resume is rejected, not signed through", async () => {
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
  stubFetchCloseTransactions(async () => {
    getTransactionsCalls++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  let submitCalls = 0;
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "final-hash" };
  });

  const { result } = renderHook(() => useCloseExecution());

  // First signer: weight 1 of 2 required - pauses, leaving a resumable envelope carrying
  // one real signature, exactly like the resume test above.
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.accumulatedWeight).toBe(1);
  expect(getTransactionsCalls).toBe(1);

  // Second signer resumes onto that same envelope, but is a black-box wallet that returns
  // a signed envelope over a DIFFERENT transaction body (a smuggled-in raised threshold)
  // instead of just co-signing the one it was actually handed.
  await act(async () => {
    await result.current.run(tamperingSigner(cosignerKeypair, source, destination));
  });

  expect(useDemolishStore.getState().lastError).toMatch(/does not match what you approved/i);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(getTransactionsCalls).toBe(1); // resumed, did not re-fetch
  expect(submitCalls).toBe(0); // rejected before ever reaching submit
});

test("useCloseExecution › a hash(x) signer's preimage completes the close by resuming, same as a second wallet (#101)", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const preimage = fromHex("deadbeef");
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
  stubFetchCloseTransactions(async () => {
    getTransactionsCalls++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  stubSubmitViaApi(async () => ({
    txHash: "final-hash",
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

  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
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
  stubFetchCloseTransactions(async () => {
    getTransactionsCalls++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });

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
  const preAuthTx = TransactionBuilder.fromXdr(preAuthXdr, Networks.TESTNET) as Transaction;
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
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "preauth-hash" };
  });

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
  const wrongKey = StrKey.encodePreAuthTx(new Uint8Array(32).fill(9));

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
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "preauth-hash" };
  });

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
  const preAuthTx = TransactionBuilder.fromXdr(preAuthXdr, Networks.TESTNET) as Transaction;
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
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "preauth-hash" };
  });

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

// #165: when the API flags a chunk needsSponsoredFee (the account can't pay its own fee -
// architecture.md §8.1), the submit step must request a fee-bump wrapper and submit the
// sponsored envelope instead of the bare, zero-fee one (which the network would reject outright).
test("useCloseExecution › a transaction flagged needsSponsoredFee is wrapped and submitted as the sponsored envelope", async () => {
  const sourceKeypair = Keypair.random();
  const feeKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();

  const mergeXdr = unsignedZeroFeeMergeXdr(sourceKeypair, destination);

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);

  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [
      { id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"], needsSponsoredFee: true },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));

  let sponsorCalls = 0;
  let sponsorSawXdr: string | undefined;
  stubFeeBumpSponsor(async (signedXdr: unknown) => {
    sponsorCalls++;
    sponsorSawXdr = signedXdr as string;
    return feeBumpXdr(signedXdr as string, feeKeypair);
  });

  let submitCalls = 0;
  let submittedXdr: string | undefined;
  stubSubmitViaApi(async (xdr: unknown) => {
    submitCalls++;
    submittedXdr = xdr as string;
    return { txHash: "final-hash" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(sponsorCalls).toBe(1);
  expect(submitCalls).toBe(1);
  // The sponsor was handed the user's fully-signed inner xdr, not the sponsored result.
  expect(sponsorSawXdr).not.toBe(submittedXdr);
  const submitted = TransactionBuilder.fromXdr(submittedXdr as string, Networks.TESTNET);
  expect(submitted).toBeInstanceOf(FeeBumpTransaction);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

// Defense-in-depth: the sponsor is trusted to add only its own signature over the exact inner
// transaction it was handed, never to substitute a different one (verify()'s trust-anchor
// pattern applied to a step verify() itself doesn't gate).
test("useCloseExecution › a fee-bump wrapping a different inner transaction is rejected, not submitted", async () => {
  const sourceKeypair = Keypair.random();
  const feeKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();

  const mergeXdr = unsignedZeroFeeMergeXdr(sourceKeypair, destination);
  // A different transaction (different destination) that the sponsor swaps in instead.
  const wrongInnerXdr = unsignedZeroFeeMergeXdr(sourceKeypair, attacker);
  const wrongInnerSigned = TransactionBuilder.fromXdr(
    wrongInnerXdr,
    Networks.TESTNET
  ) as Transaction;
  wrongInnerSigned.sign(sourceKeypair);

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);

  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [
      { id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"], needsSponsoredFee: true },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));

  stubFeeBumpSponsor(async () => feeBumpXdr(wrongInnerSigned.toXdr(), feeKeypair));

  let submitCalls = 0;
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "final-hash" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(useDemolishStore.getState().lastError).toMatch(/does not match what you approved/i);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(submitCalls).toBe(0);
});

test("useCloseExecution › a sponsor response that isn't a fee-bump transaction is rejected, not submitted", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();

  const mergeXdr = unsignedZeroFeeMergeXdr(sourceKeypair, destination);

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);

  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [
      { id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"], needsSponsoredFee: true },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));

  // A misbehaving/compromised sponsor endpoint hands back the plain signed inner transaction
  // unwrapped, instead of a fee-bump envelope.
  stubFeeBumpSponsor(async (signedXdr: unknown) => signedXdr as string);

  let submitCalls = 0;
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "final-hash" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(useDemolishStore.getState().lastError).toMatch(/did not return a fee-bump transaction/i);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(submitCalls).toBe(0);
});

test("useCloseExecution › a wallet rejection surfaces as plain language, never the raw wallet text", async () => {
  const source = Keypair.random().publicKey();

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => {
    throw new Error("User declined access");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(coSigner(source));
  });

  const { lastError } = useDemolishStore.getState();
  expect(lastError).toMatch(/declined the request in your wallet/);
  expect(lastError).not.toMatch(/User declined access/);
});

test("useCloseExecution › an API failure keeps its request id beside the unchanged user message", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    memo: null,
    mediatorRequired: false,
    lastError: null,
    lastErrorReference: null,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  const id = "0b1f2f6e-5d1c-4a52-9f0e-3a8a4b7c9d10";
  stubFetchCloseTransactions(async () => {
    throw new ApiRequestError(503, "", id);
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const state = useDemolishStore.getState();
  expect(state.lastError).toBe(
    closeFailureMessage(new ApiRequestError(503, ""), "before-submit", state.executionPlan)
  );
  expect(state.lastErrorReference).toBe(id);
});

function unsignedNormalizeXdr(sourceKeypair: Keypair, removed: string[], sequence: string): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const key of removed) {
    builder.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: key, weight: 0 } }));
  }
  builder.addOperation(
    Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 })
  );
  return builder.build().toXdr();
}

function signatureCount(xdr: string): number {
  return TransactionBuilder.fromXdr(xdr, Networks.TESTNET).signatures.length;
}

test("useCloseExecution › a round is judged against the signers and thresholds read for that round", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigners = [Keypair.random().publicKey(), Keypair.random().publicKey()];
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
        ...cosigners.map((key) => ({ key, weight: 1, type: "ed25519_public_key" })),
      ],
      thresholds: { low: 0, med: 3, high: 3 },
    } as never,
  } as never);

  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
    sourceAccount: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 1, high: 1 },
    },
  }));
  const submitted: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    submitted.push(xdr as string);
    return { txHash: "merge-hash" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(result.current.signatureStatus).toBeNull();
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(submitted).toHaveLength(1);
  expect(signatureCount(submitted[0]!)).toBe(1);
});

test("useCloseExecution › a later transaction in the round is signed against the signers an earlier one left", async () => {
  const sourceKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = cosignerKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const normalizeXdr = unsignedNormalizeXdr(sourceKeypair, [cosigner], "100");
  const mergeXdr = (() => {
    const builder = new TransactionBuilder(new Account(source, "101"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    }).setTimeout(300);
    builder.addOperation(Operation.accountMerge({ destination }));
    return builder.build().toXdr();
  })();
  const roundSigners = {
    signers: [
      { key: source, weight: 1, type: "ed25519_public_key" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  };

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: roundSigners as never,
  } as never);

  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [
        { id: "t0", order: 0, xdr: normalizeXdr, covers: ["NORMALIZE_SIGNERS"] },
        { id: "t1", order: 1, xdr: mergeXdr, covers: ["MERGE"] },
      ],
      remaining: { steps: 0, requiresAnotherCall: false },
      sourceAccount: roundSigners,
    };
  });
  const submitted: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    submitted.push(xdr as string);
    return { txHash: `hash-${submitted.length}` };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.requiredWeight).toBe(2);

  await act(async () => {
    await result.current.run(realSigner(cosignerKeypair));
  });
  expect(submitted).toHaveLength(1);
  expect(result.current.signatureStatus).toEqual({
    requiredWeight: 1,
    accumulatedWeight: 0,
    remainingSigners: [{ key: source, weight: 1, type: "ed25519_public_key" }],
  });

  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(fetches).toBe(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(submitted).toHaveLength(2);
  expect(signatureCount(submitted[1]!)).toBe(1);
});

async function twoRoundClose(roundTwoReportsSigners: boolean): Promise<void> {
  const sourceKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = cosignerKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const multisig = {
    signers: [
      { key: source, weight: 1, type: "ed25519_public_key" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  };
  const masterOnly = {
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" as const }],
    thresholds: { low: 0, med: 1, high: 1 },
  };

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: multisig as never,
  } as never);

  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    return fetches === 1
      ? {
          planHash: "h",
          status: "ready",
          transactions: [
            {
              id: "t0",
              order: 0,
              xdr: unsignedNormalizeXdr(sourceKeypair, [cosigner], "100"),
              covers: ["NORMALIZE_SIGNERS"],
            },
          ],
          remaining: { steps: 1, requiresAnotherCall: true },
          sourceAccount: multisig,
        }
      : {
          planHash: "h",
          status: "ready",
          transactions: [
            {
              id: "t1",
              order: 0,
              xdr: unsignedMergeXdr(sourceKeypair, destination),
              covers: ["MERGE"],
            },
          ],
          remaining: { steps: 0, requiresAnotherCall: false },
          ...(roundTwoReportsSigners ? { sourceAccount: masterOnly } : {}),
        };
  });
  const submitted: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    submitted.push(xdr as string);
    return { txHash: `hash-${submitted.length}` };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(result.current.signatureStatus?.requiredWeight).toBe(2);

  await act(async () => {
    await result.current.run(realSigner(cosignerKeypair));
  });
  expect(fetches).toBe(2);
  expect(submitted).toHaveLength(1);
  expect(result.current.signatureStatus).toEqual({
    requiredWeight: 1,
    accumulatedWeight: 0,
    remainingSigners: masterOnly.signers,
  });

  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(submitted).toHaveLength(2);
  expect(signatureCount(submitted[1]!)).toBe(1);
}

test("useCloseExecution › after a round normalizes the signers, the next round is signed by the master key alone", async () => {
  await twoRoundClose(true);
});

test("useCloseExecution › without a reported signer set, the next round follows what the confirmed round changed", async () => {
  await twoRoundClose(false);
});

test("useCloseExecution › a key the round no longer lists pauses for a current signer even where the threshold is 0", async () => {
  const sourceKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const masterOnly = [{ key: source, weight: 1, type: "ed25519_public_key" as const }];

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      signers: [
        ...masterOnly,
        { key: cosignerKeypair.publicKey(), weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 0, med: 0, high: 0 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [
      { id: "t0", order: 0, xdr: unsignedMergeXdr(sourceKeypair, destination), covers: ["MERGE"] },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
    sourceAccount: { signers: masterOnly, thresholds: { low: 0, med: 0, high: 0 } },
  }));
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits++;
    return { txHash: "h" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(cosignerKeypair));
  });

  expect(submits).toBe(0);
  expect(result.current.signatureStatus).toEqual({
    requiredWeight: 1,
    accumulatedWeight: 0,
    remainingSigners: masterOnly,
  });
});

async function buildRequestDecisions(
  acknowledgements: Partial<{
    defiPositionsAcknowledgedFor: string | null;
    issuerSupplyAcknowledgedFor: string | null;
  }>,
  source: string
): Promise<{ id: string; choice: string }[]> {
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    memo: null,
    mediatorRequired: false,
    lastError: null,
    assetDispositions: {},
    transferDestinations: {},
    tokenConversionFloors: {},
    claimableBalanceSelections: {},
    destinationAcknowledgedFor: null,
    positionsLeftBehind: [],
    defiPositionsAcknowledgedFor: null,
    issuerSupplyAcknowledgedFor: null,
    ...acknowledgements,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  let sent: { id: string; choice: string }[] | null = null;
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async (req: {
    decisions: { id: string; choice: string }[];
  }) => {
    sent = req.decisions;
    throw new Error("stop after the request");
  }) as unknown as typeof closeClient.fetchCloseTransactions);

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(coSigner(source));
  });
  if (!sent) throw new Error("no build request was made");
  return sent;
}

test("useCloseExecution › the build request carries the DeFi positions acknowledgement given for this account", async () => {
  const source = Keypair.random().publicKey();
  const decisions = await buildRequestDecisions({ defiPositionsAcknowledgedFor: source }, source);
  expect(decisions).toContainEqual({
    id: `defi_positions:${source}`,
    choice: "no_defi_positions_confirmed_manually",
  });
});

test("useCloseExecution › the build request carries the issuer supply acknowledgement given for this account", async () => {
  const source = Keypair.random().publicKey();
  const decisions = await buildRequestDecisions({ issuerSupplyAcknowledgedFor: source }, source);
  expect(decisions).toContainEqual({
    id: `issuer_supply:${source}`,
    choice: "stranding_holders_acknowledged",
  });
});

test("useCloseExecution › acknowledgements given for another account never reach the build request", async () => {
  const source = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  const decisions = await buildRequestDecisions(
    { defiPositionsAcknowledgedFor: other, issuerSupplyAcknowledgedFor: other },
    source
  );
  expect(
    decisions.filter((d) => d.id.startsWith("defi_positions:") || d.id.startsWith("issuer_supply:"))
  ).toEqual([]);
});

function planStep(index: number, type: string, status: string): unknown {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
  };
}

/** Round one removes nothing but restates the thresholds; round two merges. */
function twoRoundSetup(plan: unknown[]): { sourceKeypair: Keypair; rounds: () => number } {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const account = {
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
  };
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    lastErrorReference: null,
    accountState: account as never,
    executionPlan: plan,
  } as never);

  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    const confirmed = useDemolishStore
      .getState()
      .executionPlan.some((s) => s.type === "NORMALIZE_SIGNERS" && s.status === "confirmed");
    return confirmed
      ? {
          planHash: "h",
          status: "ready",
          transactions: [
            {
              id: "t1",
              order: 0,
              xdr: unsignedMergeXdr(sourceKeypair, destination),
              covers: ["MERGE"],
            },
          ],
          remaining: { steps: 0, requiresAnotherCall: false },
          sourceAccount: account,
        }
      : {
          planHash: "h",
          status: "ready",
          transactions: [
            {
              id: "t0",
              order: 0,
              xdr: unsignedNormalizeXdr(sourceKeypair, [], "100"),
              covers: ["NORMALIZE_SIGNERS"],
            },
          ],
          remaining: { steps: 1, requiresAnotherCall: true },
          sourceAccount: account,
        };
  });
  return { sourceKeypair, rounds: () => fetches };
}

/** Signs the first `approvals` transactions, then declines like a wallet does. */
function decliningAfter(keypair: Keypair, approvals: number): TransactionSigner {
  const signer = realSigner(keypair);
  let signed = 0;
  return {
    publicKey: signer.publicKey,
    sign: async (xdr, networkPassphrase) => {
      if (signed++ >= approvals) throw new Error("User declined access");
      return signer.sign(xdr, networkPassphrase);
    },
  };
}

test("useCloseExecution › a wallet decline after a confirmed round states the confirmed steps, not that nothing was sent", async () => {
  const { sourceKeypair, rounds } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  stubSubmitViaApi(async () => ({ txHash: "round-one" }));

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(decliningAfter(sourceKeypair, 1));
  });

  const { lastError, phase } = useDemolishStore.getState();
  expect(rounds()).toBe(2);
  expect(phase).toBe("STEP_FAILED");
  expect(lastError).toMatch(/declined the request in your wallet/);
  expect(lastError).toMatch(/1 of 2 plan steps are already confirmed/);
  expect(lastError).not.toMatch(/nothing was sent/i);
});

test("useCloseExecution › a step left submitted but unconfirmed by the failing round is not counted as confirmed", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "CANCEL_OFFERS", "confirmed"),
    planStep(1, "NORMALIZE_SIGNERS", "submitted"),
    planStep(2, "MERGE", "pending"),
  ]);
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(504, "");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const { lastError } = useDemolishStore.getState();
  expect(lastError).toMatch(/1 of 3 plan steps are already confirmed/);
  expect(lastError).toMatch(/could not be confirmed/);
});

test("useCloseExecution › after a failed submit and a retry, a later wallet decline reads as not sent, not as unconfirmed", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits++;
    if (submits === 1) throw new ApiRequestError(504, "");
    return { txHash: "round-one" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().lastError).toMatch(/could not be confirmed/);

  await act(async () => {
    await result.current.run(decliningAfter(sourceKeypair, 1));
  });

  const { lastError } = useDemolishStore.getState();
  expect(submits).toBe(2);
  expect(lastError).toMatch(/This transaction was not signed or sent/);
  expect(lastError).toMatch(/1 of 2 plan steps are already confirmed/);
  expect(lastError).not.toMatch(/could not be confirmed/);
});

test("useCloseExecution › an account that kept changing discards the plan for a fresh review instead of failing", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    memo: null,
    mediatorRequired: false,
    lastError: null,
    planChangedNotice: null,
    phase: "STEP_EXECUTING",
    executionPlan: [{ type: "MERGE", status: "pending", operationCount: 1 }] as never,
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  let calls = 0;
  stubFetchCloseTransactions(async () => {
    calls++;
    throw new ApiRequestError(409, "changed", undefined, "state_changed");
  });
  const waits: number[] = [];
  spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const state = useDemolishStore.getState();
  expect(calls).toBe(3);
  expect(waits).toEqual([STATE_CHANGED_REFETCH_DELAY_MS, STATE_CHANGED_REFETCH_DELAY_MS]);
  expect(state.phase).not.toBe("STEP_FAILED");
  expect(state.phase).not.toBe("STEP_EXECUTING");
  expect(state.executionPlan).toEqual([]);
  expect(state.lastError).toBeNull();
  expect(state.planChangedNotice).toBe(PLAN_CHANGED_NOTICE);
  expect(result.current.signatureStatus).toBeNull();
});
