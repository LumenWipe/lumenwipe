import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { renderHook, act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as navigation from "next/navigation";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  hash,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  STATE_CHANGED_REFETCH_DELAY_MS,
  SUBMIT_RESEND_ATTEMPTS,
  SUBMIT_RESEND_DELAY_MS,
} from "@lumenwipe/sdk";
import { PLAN_CHANGED_NOTICE, useCloseExecution } from "@/hooks/useCloseExecution";
import { walletAccountMismatch, walletNotUsable } from "@/lib/utils/user-error";
import { progressLine } from "@/lib/execution/progress";
import { LeaveGuardProvider } from "@/components/layout/LeaveGuard";
import NavBar from "@/components/layout/NavBar";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import * as closeClient from "@/lib/api/close-client";
import * as submitViaApiModule from "@/lib/stellar/submit-via-api";
import { submissionHash } from "@/lib/stellar/submission";
import * as verifyModule from "@/lib/stellar/verify";
import * as feeBumpSponsorModule from "@/lib/stellar/fee-bump-sponsor";
import * as mediatorModule from "@/lib/stellar/mediator";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
import {
  ApiRequestError,
  CLOSE_INTERRUPTED,
  closeFailureMessage,
  HASH_NOT_KEPT,
  NO_MERGE_CONFIRMED,
  PREIMAGE_EXPOSED,
} from "@/lib/utils/user-error";
import { deriveJourneyState } from "@/lib/journey/journey-state";
import * as recovery from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import {
  WALLET_CONNECT_WALLET_ID,
  WalletKitSigner,
  WalletNotUsableError,
  WalletSigningError,
  type TransactionSigner,
} from "@/lib/stellar/signer";
import { fromHex, toHex } from "@/lib/stellar/hex";
import { TRANSFER_DESTINATION_REFUSED_NOTICE } from "@/lib/plan/transfer-destination";
import { CLOCK_HINT, WALLET_TIMED_OUT } from "@/lib/utils/user-error";
import ReviewView from "@/components/review/ReviewView";
import * as closeRecord from "@/lib/session/close-record";
import * as signingPromptModule from "@/lib/execution/signing-prompt";
import { freshAccount, freshPlan, stubUnchangedRefresh } from "./fixtures/fresh-plan";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";

/** The stand-ins return only what the hook reads, so they are typed loosely on purpose. */
function stubFetchCloseTransactions(impl: () => Promise<unknown>): void {
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation(
    impl as unknown as typeof closeClient.fetchCloseTransactions
  );
}
/** Answers with the hash of what was actually sent, unless a test names `wrongHash`. */
function stubSubmitViaApi(impl: (...args: unknown[]) => Promise<unknown>): void {
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation((async (...args: unknown[]) => {
    const answer = (await impl(...args)) as { wrongHash?: string; ledger?: number };
    return {
      ledger: answer?.ledger ?? 0,
      txHash: answer?.wrongHash ?? submissionHash(args[0] as string, Networks.TESTNET),
    };
  }) as unknown as typeof submitViaApiModule.submitViaApi);
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
  useDemolishStore.setState({
    unconfirmedSubmission: null,
    sessionId: "session",
    signingRun: false,
  });
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true);
  spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => true);
  spyOn(sessionStore, "loadSession").mockImplementation(async () => ({ id: "session" }) as never);
  stubFetchCloseTransactions(async () => {
    throw new Error("not mocked in this test");
  });
});
afterEach(() => {
  mock.restore();
});

/** A wallet's decline, as WalletKitSigner throws it. */
const USER_DECLINED = new WalletSigningError(-4, VARIAL_ID, "User declined access");

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

  const mergeXdr = new TransactionBuilder(new Account(source, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(300)
    .addOperation(Operation.setOptions({ signer: { sha256Hash: hash(preimage), weight: 0 } }))
    .addOperation(Operation.accountMerge({ destination }))
    .build()
    .toXdr();

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
  // The signed list is the envelope's own evaluated contributions, with the weight each added.
  expect(result.current.signatureStatus?.contributed).toEqual([
    { key: source, weight: 1, type: "ed25519_public_key" },
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

function singleSigSetup(): string {
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
  return source;
}

test("useCloseExecution › a wallet rejection surfaces as plain language, never the raw wallet text", async () => {
  const { sourceKeypair } = mergeSetup();
  const source = sourceKeypair.publicKey();
  const declining: TransactionSigner = {
    publicKey: source,
    sign: async () => {
      throw USER_DECLINED;
    },
  };

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(declining);
  });

  const { lastError } = useDemolishStore.getState();
  expect(lastError).toMatch(/declined the request in your wallet/);
  expect(lastError).not.toMatch(/User declined access/);
});

test("useCloseExecution › a failure outside the wallet that reads like one is not reported as the wallet's", async () => {
  const source = singleSigSetup();
  for (const raw of ["User declined access", "request timed out"]) {
    stubFetchCloseTransactions(async () => {
      throw new Error(raw);
    });
    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(coSigner(source));
    });
    const { lastError } = useDemolishStore.getState();
    expect(lastError).not.toMatch(/wallet/i);
    expect(lastError).not.toContain(raw);
  }
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
    contributed: [],
    remainingSigners: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    notice: null,
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
    contributed: [],
    remainingSigners: masterOnly.signers,
    notice: null,
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
    contributed: [],
    remainingSigners: masterOnly,
    notice: null,
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
      if (signed++ >= approvals) throw USER_DECLINED;
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

function mergeSetup(): { sourceKeypair: Keypair; mergeXdr: string } {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const mergeXdr = unsignedMergeXdr(sourceKeypair, destination);
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
    executionPlan: [planStep(0, "MERGE", "pending")],
  } as never);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
    sourceAccount: account,
  }));
  return { sourceKeypair, mergeXdr };
}

/** The resend waits run at once; every other timer keeps its real delay. */
function skipResendWaits(): void {
  const real = globalThis.setTimeout;
  spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(fn, ms === SUBMIT_RESEND_DELAY_MS ? 0 : ms)) as unknown as typeof setTimeout);
}

function stubLookup(impl: (hash: string) => Promise<unknown>): void {
  spyOn(submitViaApiModule, "lookupViaApi").mockImplementation(
    impl as unknown as typeof submitViaApiModule.lookupViaApi
  );
}

const SEARCHED = {
  oldestLedger: 1,
  oldestLedgerCloseTime: 1,
  latestLedger: 2,
  latestLedgerCloseTime: 2_000_000_000,
};

test("useCloseExecution › an unknown outcome ends unconfirmed with the client's hash, never failed", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "CANCEL_OFFERS", "confirmed"),
    planStep(1, "NORMALIZE_SIGNERS", "submitted"),
    planStep(2, "MERGE", "pending"),
  ]);
  skipResendWaits();
  const sent: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    sent.push(xdr as string);
    throw new ApiRequestError(504, "");
  });
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_UNCONFIRMED");
  expect(state.lastError).toBeNull();
  expect(state.unconfirmedSubmission?.hash).toBe(submissionHash(sent[0]!, Networks.TESTNET));
  expect(sent).toHaveLength(1 + SUBMIT_RESEND_ATTEMPTS);
  expect(new Set(sent).size).toBe(1);
  // It may still land, so its step reads as sent, never as failed.
  expect(state.executionPlan.map((s) => s.status)).toEqual(["confirmed", "submitted", "pending"]);
});

test("useCloseExecution › a failed lookup or a 503 while reconciling stays unconfirmed", async () => {
  const { sourceKeypair } = twoRoundSetup([planStep(0, "MERGE", "pending")]);
  skipResendWaits();
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(503, "");
  });
  stubLookup(async () => {
    throw new ApiRequestError(503, "");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");

  await act(async () => {
    await result.current.checkUnconfirmed();
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(useDemolishStore.getState().lastError).toBeNull();
  expect(result.current.stillUnconfirmed).toBe(true);
});

test("useCloseExecution › a refused submit clears the record and reads as not having taken effect", async () => {
  const { sourceKeypair } = twoRoundSetup([planStep(0, "MERGE", "pending")]);
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(422, "The network rejected it.", undefined, "submit_rejected");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.unconfirmedSubmission).toBeNull();
  expect(state.lastError).toMatch(/safe to retry/);
  expect(result.current.retrySafe).toBe(true);
});

test("useCloseExecution › a refused transaction that carried a preimage never reads as safe", async () => {
  const preimage = new Uint8Array(32).fill(7);
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  const { sourceKeypair } = twoRoundSetup([planStep(0, "MERGE", "pending")]);
  const source = sourceKeypair.publicKey();
  useDemolishStore.setState({
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: hashXKey, weight: 1, type: "hash_x" },
      ],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  const dest = Keypair.random().publicKey();
  const xdr = new TransactionBuilder(new Account(source, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ signer: { sha256Hash: hash(preimage), weight: 0 } }))
    .addOperation(Operation.accountMerge({ destination: dest }))
    .setTimeout(300)
    .build()
    .toXdr();
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  stubFetchCloseTransactions(async () => ({
    transactions: [{ id: "t", order: 1, xdr, covers: ["MERGE"] }],
    remaining: { requiresAnotherCall: false, steps: 0 },
  }));
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(422, "The network rejected it.", undefined, "submit_rejected");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realHashXSigner(preimage));
  });

  const { lastError } = useDemolishStore.getState();
  expect(lastError).toContain(PREIMAGE_EXPOSED);
  expect(lastError).not.toMatch(/safe to retry/i);
  expect(result.current.retrySafe).toBe(false);
});

test("useCloseExecution › a merge confirmed by the client's hash after an unknown outcome completes", async () => {
  const { sourceKeypair, mergeXdr } = mergeSetup();
  skipResendWaits();
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(504, "");
  });
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(useDemolishStore.getState().unconfirmedSubmission?.covers).toContain("MERGE");

  const fetched: unknown[] = [];
  stubFetchCloseTransactions(async () => {
    fetched.push(mergeXdr);
    throw new ApiRequestError(404, "gone", undefined, "account_not_found");
  });
  stubLookup(async (hash) => ({ status: "confirmed", hash, ledger: 9 }));
  await act(async () => {
    await result.current.checkUnconfirmed();
  });

  const state = useDemolishStore.getState();
  expect(state.phase).toBe("COMPLETE");
  expect(state.unconfirmedSubmission).toBeNull();
  expect(state.executionPlan.find((s) => s.type === "MERGE")?.status).toBe("confirmed");
  expect(fetched).toHaveLength(0);
});

test("useCloseExecution › an API answering with another transaction's hash never completes", async () => {
  const { sourceKeypair } = mergeSetup();
  skipResendWaits();
  stubSubmitViaApi(async () => ({ wrongHash: "f".repeat(64) }));
  stubLookup(async () => ({ status: "confirmed", hash: "f".repeat(64), ledger: 9 }));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(useDemolishStore.getState().executionPlan[0]?.status).not.toBe("confirmed");
});

test("useCloseExecution › covers claiming a merge on a transaction with none never closes the account", async () => {
  const { sourceKeypair } = mergeSetup();
  const removal = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "a", value: null }))
    .setTimeout(300)
    .build()
    .toXdr();
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t", order: 0, xdr: removal, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.lastError).toBe(NO_MERGE_CONFIRMED);
  expect(
    deriveJourneyState({
      phase: state.phase,
      plan: state.executionPlan,
      inFlight: false,
      saved: true,
    }).mergeConfirmed
  ).toBe(false);
  expect(state.executionPlan[0]?.status).not.toBe("confirmed");
});

test("useCloseExecution › a hash saved before a refresh stops run from signing anything", async () => {
  const { sourceKeypair } = mergeSetup();
  spyOn(recovery, "findUnresolved").mockImplementation(
    async () =>
      ({
        unconfirmed: { hash: "a".repeat(64), covers: ["MERGE"], validUntil: 2_000_000_000 },
      }) as never
  );
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));
  const signer = realSigner(sourceKeypair);
  const sign = spyOn(signer, "sign");
  const fetched = spyOn(closeClient, "fetchCloseTransactions");
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(signer);
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(sign).not.toHaveBeenCalled();
  expect(fetched).not.toHaveBeenCalled();
});

test("useCloseExecution › an envelope with no upper time bound is never sent", async () => {
  const { sourceKeypair } = mergeSetup();
  const unbounded = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }))
    .setTimeout(0)
    .build()
    .toXdr();
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t", order: 0, xdr: unbounded, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(sent).toBe(0);
  expect(useDemolishStore.getState().unconfirmedSubmission).toBeNull();
  expect(useDemolishStore.getState().lastError).toMatch(/no time limit/);
});

test("useCloseExecution › a failed write of the hash stops before anything is sent", async () => {
  const { sourceKeypair } = mergeSetup();
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(() =>
    Promise.reject(new Error("quota"))
  );
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(sent).toBe(0);
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.unconfirmedSubmission).toBeNull();
  expect(state.lastError).toContain(HASH_NOT_KEPT);
  expect(state.lastError).toContain("No new transaction was sent.");
});

test("useCloseExecution › a session that cannot be put back stops before anything is signed", async () => {
  const { sourceKeypair } = mergeSetup();
  spyOn(sessionStore, "loadSession").mockImplementation(async () => null);
  spyOn(sessionStore, "saveSession").mockImplementation(() => Promise.reject(new Error("quota")));
  const signer = realSigner(sourceKeypair);
  const sign = spyOn(signer, "sign");
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(signer);
  });
  expect(sign).not.toHaveBeenCalled();
  expect(sent).toBe(0);
  expect(useDemolishStore.getState().lastError).toContain(HASH_NOT_KEPT);
});

test.each([
  ["a session id", "session"],
  ["no session id", null],
] as const)(
  "useCloseExecution › a record dismissed before the first transaction is put back, with %s",
  async (_, sessionId) => {
    const { sourceKeypair } = mergeSetup();
    useDemolishStore.setState({ sessionId });
    const held = new Set<string>();
    spyOn(sessionStore, "loadSession").mockImplementation(
      async (id) => (held.has(id) ? { id } : null) as never
    );
    const saved = spyOn(sessionStore, "saveSession").mockImplementation(async (record) => {
      held.add(record.id);
    });
    const written = spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async (id, sub) =>
      sub ? held.has(id) : true
    );
    stubSubmitViaApi(async () => ({}));
    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]?.[0].sourceAddress).toBe(sourceKeypair.publicKey());
    expect(written.mock.calls.some(([, sub]) => sub !== null)).toBe(true);
    expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  }
);

test("useCloseExecution › a record dismissed between transactions is put back and the close ends", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  useDemolishStore.setState({ sessionId: "session" });
  let present = true;
  spyOn(sessionStore, "loadSession").mockImplementation(
    async (id) => (present ? { id } : null) as never
  );
  const saved = spyOn(sessionStore, "saveSession").mockImplementation(async () => {
    present = true;
  });
  const hashes: string[] = [];
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async (_id, sub) => {
    if (!sub) return true;
    if (!present) return false;
    hashes.push(sub.hash);
    return true;
  });
  stubSubmitViaApi(async () => {
    present = false;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(hashes).toHaveLength(2);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(useDemolishStore.getState().lastError).toBeNull();
});

test("useCloseExecution › each confirmation is recorded with its hash in the run's saved close", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  useDemolishStore.setState({ sessionId: "session" });
  const recorded = spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => true);
  const sent: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    sent.push(xdr as string);
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(recorded.mock.calls).toEqual([
    [
      "session",
      {
        txHash: submissionHash(sent[0]!, Networks.TESTNET),
        type: "NORMALIZE_SIGNERS",
        closesAccount: false,
        currentStepIndex: 1,
      },
    ],
    [
      "session",
      {
        txHash: submissionHash(sent[1]!, Networks.TESTNET),
        type: "MERGE",
        closesAccount: true,
        currentStepIndex: 2,
      },
    ],
  ]);
  const written = JSON.stringify(recorded.mock.calls);
  for (const xdr of sent) expect(written).not.toContain(xdr);
  expect(written).not.toContain(sourceKeypair.secret());
  expect(useDemolishStore.getState().progressNotSaved).toBe(false);
});

test("useCloseExecution › a failed progress write never fails the close and shows a notice", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  spyOn(sessionStore, "recordConfirmed").mockRejectedValue(new Error("QuotaExceededError"));
  spyOn(console, "error").mockImplementation(() => {});
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("COMPLETE");
  expect(state.lastError).toBeNull();
  expect(state.progressNotSaved).toBe(true);
});

test("useCloseExecution › a record gone when a confirmation lands is not recreated and shows a notice", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({ sessionId: "session" });
  spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => false);
  const saved = spyOn(sessionStore, "saveSession").mockImplementation(async () => {});
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(saved).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().progressNotSaved).toBe(true);
});

/** Leaves the close the way a person does mid-run: the logo, then Leave in the confirm. */
async function leaveFromDialog(): Promise<void> {
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  await act(async () => {
    render(
      <LeaveGuardProvider>
        <NavBar network="testnet" />
      </LeaveGuardProvider>
    );
  });
  fireEvent.click(screen.getByRole("link", { name: "LumenWipe home" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  });
  expect(useDemolishStore.getState().sourceAddress).toBeNull();
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 0));
}

function counting(signer: TransactionSigner): TransactionSigner & { signs: () => number } {
  let signs = 0;
  return {
    publicKey: signer.publicKey,
    sign: async (xdr, passphrase) => {
      signs++;
      return signer.sign(xdr, passphrase);
    },
    signs: () => signs,
  };
}

test("useCloseExecution › leaving from the confirm while a round is fetched signs and sends nothing", async () => {
  const { sourceKeypair, mergeXdr } = mergeSetup();
  useDemolishStore.setState({ phase: "STEP_EXECUTING", sessionId: "session" });
  let release!: () => void;
  const fetched = new Promise<void>((resolve) => (release = resolve));
  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    await fetched;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
      sourceAccount: {
        signers: [{ key: sourceKeypair.publicKey(), weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 0, med: 1, high: 1 },
      },
    };
  });
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const signer = counting(realSigner(sourceKeypair));
  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(signer);
    await until(() => fetches === 1);
  });

  await leaveFromDialog();
  await act(async () => {
    release();
    await running;
  });

  expect(signer.signs()).toBe(0);
  expect(sent).toBe(0);
});

test("useCloseExecution › a page remounted during a live run cannot start a second one", async () => {
  const { sourceKeypair, mergeXdr } = mergeSetup();
  useDemolishStore.setState({ phase: "STEP_EXECUTING", sessionId: "session" });
  let release!: () => void;
  const fetched = new Promise<void>((resolve) => (release = resolve));
  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    await fetched;
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
      sourceAccount: {
        signers: [{ key: sourceKeypair.publicKey(), weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 0, med: 1, high: 1 },
      },
    };
  });
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const first = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = first.result.current.run(realSigner(sourceKeypair));
    await until(() => fetches === 1);
  });

  const remounted = renderHook(() => useCloseExecution());
  await act(async () => {
    await remounted.result.current.run(realSigner(sourceKeypair));
  });
  expect(fetches).toBe(1);
  expect(useDemolishStore.getState().signingRun).toBe(true);

  await act(async () => {
    release();
    await running;
  });
  expect(sent).toBe(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(useDemolishStore.getState().signingRun).toBe(false);
});

test("useCloseExecution › leaving during the saved-hash read leaves no run marked live", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({ phase: "STEP_EXECUTING", sessionId: "session" });
  let release!: () => void;
  const read = new Promise<null>((resolve) => (release = () => resolve(null)));
  let reading = false;
  spyOn(recovery, "findUnresolved").mockImplementation(async () => {
    reading = true;
    return read;
  });
  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(realSigner(sourceKeypair));
    await until(() => reading);
  });

  await leaveFromDialog();
  await act(async () => {
    release();
    await running;
  });

  expect(useDemolishStore.getState().signingRun).toBe(false);
});

test("useCloseExecution › a wallet prompt approved after leaving sends nothing, even with the same account loaded again", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({ phase: "STEP_EXECUTING", sessionId: "session" });
  const reload = { ...useDemolishStore.getState() };
  let approve!: () => void;
  const approved = new Promise<void>((resolve) => (approve = resolve));
  let prompted = false;
  const signer = realSigner(sourceKeypair);
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run({
      publicKey: signer.publicKey,
      sign: async (xdr, passphrase) => {
        prompted = true;
        await approved;
        return signer.sign(xdr, passphrase);
      },
    });
    await until(() => prompted);
  });

  await leaveFromDialog();
  useDemolishStore.setState({
    sourceAddress: reload.sourceAddress,
    destinationAddress: reload.destinationAddress,
    accountState: reload.accountState,
    executionPlan: reload.executionPlan,
    phase: "STEP_EXECUTING",
    sessionId: "session",
  });
  spyOn(sessionStore, "saveSession").mockImplementation(async () => {});
  await act(async () => {
    approve();
    await running;
  });

  expect(sent).toBe(0);
});

test("useCloseExecution › a confirmation landing after the person left is still recorded, and nothing more is signed", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  useDemolishStore.setState({ phase: "STEP_EXECUTING", sessionId: "session" });
  const recorded = spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => true);
  let release!: () => void;
  const landed = new Promise<void>((resolve) => (release = resolve));
  const sent: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    sent.push(xdr as string);
    await landed;
    return {};
  });
  const signer = counting(realSigner(sourceKeypair));
  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(signer);
    await until(() => sent.length === 1);
  });

  await leaveFromDialog();
  await act(async () => {
    release();
    await running;
  });

  expect(signer.signs()).toBe(1);
  expect(sent).toHaveLength(1);
  expect(recorded.mock.calls).toEqual([
    [
      "session",
      {
        txHash: submissionHash(sent[0]!, Networks.TESTNET),
        type: "NORMALIZE_SIGNERS",
        closesAccount: false,
        currentStepIndex: null,
      },
    ],
  ]);
  expect(useDemolishStore.getState().signingRun).toBe(false);
});

function moveToAnotherAccount(): string {
  const other = Keypair.random().publicKey();
  useDemolishStore.getState().setAddresses(other, Keypair.random().publicKey());
  useDemolishStore.setState({
    phase: "STEP_EXECUTING",
    executionPlan: [planStep(0, "MERGE", "pending")] as never,
  });
  return other;
}

test("useCloseExecution › another account taking the tab stops the next send and writes nothing", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  const saved = spyOn(sessionStore, "saveSession").mockImplementation(async () => {});
  const written = spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true);
  let sent = 0;
  let other = "";
  stubSubmitViaApi(async () => {
    sent++;
    other = moveToAnotherAccount();
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(sent).toBe(1);
  expect(saved).not.toHaveBeenCalled();
  expect(written.mock.calls.filter(([, sub]) => sub !== null)).toHaveLength(1);
  expect(state.sourceAddress).toBe(other);
  expect(state.sessionId).toBeNull();
  expect(state.phase).toBe("STEP_EXECUTING");
  expect(state.lastError).toBeNull();
  expect(state.unconfirmedSubmission).toBeNull();
});

test("useCloseExecution › a late confirmation of one account never touches the next", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({ sessionId: "session" });
  const clear = spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  const recorded = spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => false);
  stubSubmitViaApi(async () => {
    moveToAnotherAccount();
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_EXECUTING");
  expect(state.executionPlan[0]?.status).toBe("pending");
  expect(state.lastError).toBeNull();
  expect(clear).toHaveBeenCalledWith("testnet", sourceKeypair.publicKey());
  expect(recorded.mock.calls.map(([id, c]) => [id, c.currentStepIndex])).toEqual([
    ["session", null],
  ]);
  expect(state.progressNotSaved).toBe(false);
});

test("useCloseExecution › a late unknown outcome of one account leaves the next alone and the hold in place", async () => {
  const { sourceKeypair } = mergeSetup();
  skipResendWaits();
  const clear = spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  stubSubmitViaApi(async () => {
    moveToAnotherAccount();
    throw new ApiRequestError(504, "");
  });
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_EXECUTING");
  expect(state.unconfirmedSubmission).toBeNull();
  expect(clear).not.toHaveBeenCalled();
});

test("useCloseExecution › another account arriving while a round is fetched stops before signing", async () => {
  const { sourceKeypair, mergeXdr } = mergeSetup();
  stubFetchCloseTransactions(async () => {
    moveToAnotherAccount();
    return {
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  const signer = realSigner(sourceKeypair);
  const sign = spyOn(signer, "sign");
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(signer);
  });
  expect(sign).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
});

test("useCloseExecution › another account arriving while the hash is written stops the send", async () => {
  const { sourceKeypair } = mergeSetup();
  skipResendWaits();
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async (_id, sub) => {
    if (sub) moveToAnotherAccount();
    return true;
  });
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));
  let sent = 0;
  stubSubmitViaApi(async () => {
    sent++;
    return {};
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(sent).toBe(0);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
});

test("useCloseExecution › another account arriving while the session is read writes no hash", async () => {
  const { sourceKeypair } = mergeSetup();
  let reads = 0;
  spyOn(sessionStore, "loadSession").mockImplementation(async (id) => {
    if (++reads === 2) moveToAnotherAccount();
    return { id } as never;
  });
  const written = spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true);
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(written.mock.calls.filter(([, sub]) => sub !== null)).toHaveLength(0);
});

test("useCloseExecution › a left-over confirmed after another account arrived marks nothing", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({
    unconfirmedSubmission: { hash: "a".repeat(64), covers: ["MERGE"], validUntil: 2_000_000_000 },
  });
  spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  stubLookup(async (hash) => {
    moveToAnotherAccount();
    return { status: "confirmed", hash, ledger: 1 };
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.executionPlan[0]?.status).toBe("pending");
  expect(state.phase).toBe("STEP_EXECUTING");
});

test("useCloseExecution › a failed clear after settling never stops the close", async () => {
  const { sourceKeypair } = mergeSetup();
  spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {
    throw new Error("quota");
  });
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("useCloseExecution › past the give-up deadline a merged account stays plain language, never complete", async () => {
  const { sourceKeypair } = mergeSetup();
  useDemolishStore.setState({
    unconfirmedSubmission: { hash: "a".repeat(64), covers: ["MERGE"], validUntil: 1000 },
  });
  stubLookup(async (hash) => ({
    status: "not_found",
    hash,
    searched: { ...SEARCHED, latestLedgerCloseTime: 2_000_000_000 },
  }));
  stubFetchCloseTransactions(async () => {
    throw new ApiRequestError(404, "gone", undefined, "account_not_found");
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.lastError).toMatch(/no longer on the network/);
  expect(state.lastError).not.toMatch(/safe to retry/i);
  expect(result.current.retrySafe).toBe(false);
});

test("useCloseExecution › after a settled unknown outcome, a later wallet decline reads as not sent", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  skipResendWaits();
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits++;
    if (submits === 1) throw new ApiRequestError(504, "");
    return {};
  });

  const { result } = renderHook(() => useCloseExecution());
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

test("useCloseExecution › the reviewed plan hash is sent until a transaction confirms, then cleared", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    destinationAcknowledgedFor: destination,
    memo: null,
    mediatorRequired: false,
    executionPlan: [],
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
      nativeBalanceLumens: "10",
    } as never,
  } as never);
  useDemolishStore.getState().setPlan([], "a".repeat(64));

  const sent: Array<string | undefined> = [];
  const rounds = [true, false];
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async (req: {
    planHash?: string;
  }) => {
    sent.push(req.planHash);
    const more = rounds.shift()!;
    return {
      planHash: "h",
      status: "ready",
      transactions: [
        {
          id: `tx-${sent.length}`,
          order: 0,
          dependsOn: [],
          xdr: unsignedMergeXdr(sourceKeypair, destination),
          networkPassphrase: Networks.TESTNET,
          covers: ["MERGE"],
        },
      ],
      remaining: { steps: more ? 1 : 0, requiresAnotherCall: more },
    };
  }) as unknown as typeof closeClient.fetchCloseTransactions);
  stubSubmitViaApi(async () => "hash");

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(sent).toEqual(["a".repeat(64), undefined]);
  expect(useDemolishStore.getState().planHash).toBeNull();
});

test("useCloseExecution › the build sends the hash of the plan the review's confirm fetched, not the reviewed one", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const reviewedHash = "a".repeat(64);
  const freshHash = "b".repeat(64);
  const merge = {
    index: 0,
    type: "MERGE" as const,
    title: "MERGE",
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status: "pending" as const,
    txHash: null,
    error: null,
  };
  const account = freshAccount(source, {
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 1, med: 1, high: 1 },
    nativeBalanceLumens: "10.0000000",
  } as never);
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    destinationAcknowledgedFor: destination,
    memo: null,
    mediatorRequired: false,
    sessionId: null,
    accountState: account,
  } as never);
  useDemolishStore.getState().setPlan([merge], reviewedHash, 1);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
  stubUnchangedRefresh(account, freshPlan([merge], { planHash: freshHash }));
  spyOn(recovery, "readUnresolved").mockResolvedValue(null);
  spyOn(closeRecord, "saveCloseSession").mockResolvedValue("session");
  spyOn(navigation, "useRouter").mockImplementation(
    () => ({ push: () => {}, replace: () => {} }) as never
  );

  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /continue to signing/i }));
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");

  const sent: Array<string | undefined> = [];
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async (req: {
    planHash?: string;
  }) => {
    sent.push(req.planHash);
    return {
      planHash: freshHash,
      status: "ready",
      transactions: [
        {
          id: "tx-1",
          order: 0,
          dependsOn: [],
          xdr: unsignedMergeXdr(sourceKeypair, destination),
          networkPassphrase: Networks.TESTNET,
          covers: ["MERGE"],
        },
      ],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  }) as unknown as typeof closeClient.fetchCloseTransactions);
  stubSubmitViaApi(async () => "hash");

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(sent[0]).toBe(freshHash);
  expect(sent).not.toContain(reviewedHash);
});

test("useCloseExecution › aborts before submit when the mediator co-sign returns a changed body", async () => {
  const originalRegistry = activeRegistry();
  setRegistry({ ...originalRegistry, validUntil: "2999-12-31" });
  try {
    const sourceKeypair = Keypair.random();
    const mediatorKeypair = Keypair.random();
    const source = sourceKeypair.publicKey();
    const exchange = originalRegistry.entries.find((entry) => entry.requiresMediator)!.address;
    const mediatedMergeAt = (sequence: string): Transaction =>
      new TransactionBuilder(new Account(source, sequence), {
        fee: "200",
        networkPassphrase: Networks.TESTNET,
        memo: Memo.text("123"),
      })
        .setTimeout(300)
        .addOperation(Operation.accountMerge({ destination: mediatorKeypair.publicKey() }))
        .addOperation(
          Operation.payment({
            source: mediatorKeypair.publicKey(),
            destination: exchange,
            asset: Asset.native(),
            amount: "50",
          })
        )
        .build();

    useNetworkStore.setState({ network: "testnet" });
    useDemolishStore.setState({
      sourceAddress: source,
      destinationAddress: exchange,
      memo: "123",
      mediatorRequired: true,
      lastError: null,
      accountState: {
        nativeBalanceLumens: "50",
        signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 1, med: 1, high: 1 },
      } as never,
    } as never);
    stubFetchCloseTransactions(async () => ({
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t", order: 0, xdr: mediatedMergeAt("100").toXdr(), covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    }));
    let submitCalls = 0;
    stubSubmitViaApi(async () => {
      submitCalls++;
      return { txHash: "final-hash" };
    });
    // Signed by both parties, so only the hash check stands between this body and submit.
    const changedBody = mediatedMergeAt("200");
    changedBody.sign(sourceKeypair, mediatorKeypair);
    const cosign = spyOn(mediatorModule, "requestMediatorCosignature").mockImplementation(
      async () => changedBody.toXdr()
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });

    expect(cosign).toHaveBeenCalledTimes(1);
    expect(useDemolishStore.getState().lastError).toMatch(
      /co-signed transaction does not match what you approved/i
    );
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    expect(submitCalls).toBe(0);
  } finally {
    setRegistry(originalRegistry);
  }
});

test("useCloseExecution › co-signs and submits a mediated close from the registry, whatever the store says", async () => {
  const originalRegistry = activeRegistry();
  setRegistry({ ...originalRegistry, validUntil: "2999-12-31" });
  try {
    const sourceKeypair = Keypair.random();
    const mediatorKeypair = Keypair.random();
    const source = sourceKeypair.publicKey();
    const exchange = originalRegistry.entries.find((entry) => entry.requiresMediator)!.address;
    const mediatedMerge = new TransactionBuilder(new Account(source, "100"), {
      fee: "200",
      networkPassphrase: Networks.TESTNET,
      memo: Memo.text("123"),
    })
      .setTimeout(300)
      .addOperation(Operation.accountMerge({ destination: mediatorKeypair.publicKey() }))
      .addOperation(
        Operation.payment({
          source: mediatorKeypair.publicKey(),
          destination: exchange,
          asset: Asset.native(),
          amount: "50",
        })
      )
      .build();

    useNetworkStore.setState({ network: "testnet" });
    useDemolishStore.setState({
      sourceAddress: source,
      destinationAddress: exchange,
      memo: "123",
      // What a restored session can carry: the store says no intermediary.
      mediatorRequired: false,
      lastError: null,
      accountState: {
        nativeBalanceLumens: "50",
        signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 1, med: 1, high: 1 },
      } as never,
    } as never);
    stubFetchCloseTransactions(async () => ({
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t", order: 0, xdr: mediatedMerge.toXdr(), covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    }));
    const submitted: string[] = [];
    stubSubmitViaApi(async (xdr) => {
      submitted.push(xdr as string);
      return {};
    });
    const cosign = spyOn(mediatorModule, "requestMediatorCosignature").mockImplementation(
      async (xdr: string) => {
        const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
        tx.sign(mediatorKeypair);
        return tx.toEnvelope().toXdr("base64");
      }
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });

    expect(cosign).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(1);
    const sent = TransactionBuilder.fromXdr(submitted[0]!, Networks.TESTNET) as Transaction;
    expect(toHex(sent.hash())).toBe(toHex(mediatedMerge.hash()));
    expect(sent.signatures).toHaveLength(2);
  } finally {
    setRegistry(originalRegistry);
  }
});

test("useCloseExecution › aborts before submit when a wallet returns a changed body", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const mergeAt = (sequence: string): Transaction =>
    new TransactionBuilder(new Account(source, sequence), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(300)
      .addOperation(Operation.accountMerge({ destination }))
      .build();

  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    accountState: {
      nativeBalanceLumens: "50",
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t", order: 0, xdr: mergeAt("100").toXdr(), covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));
  let submitCalls = 0;
  stubSubmitViaApi(async () => {
    submitCalls++;
    return { txHash: "final-hash" };
  });
  const wallet: TransactionSigner = {
    publicKey: source,
    sign: async () => {
      const changedBody = mergeAt("200");
      changedBody.sign(sourceKeypair);
      return changedBody.toXdr();
    },
  };

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(wallet);
  });

  expect(useDemolishStore.getState().lastError).toMatch(
    /signed transaction does not match what you approved/i
  );
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(submitCalls).toBe(0);
});

test("a freshly mounted close claims nothing about whether a retry is safe", () => {
  const { result } = renderHook(() => useCloseExecution());
  expect(result.current.retrySafe).toBeNull();
});

test.each([
  ["4411", "id", "id"],
  ["deposit", "text", "text"],
  [null, "id", undefined],
  // A record saved before the type was chosen: the API's own default, now sent explicitly.
  ["4411", null, "text"],
] as const)(
  "useCloseExecution › memo %p of type %p asks for the transactions with memoType %p",
  async (memo, memoType, sent) => {
    const source = Keypair.random();
    useNetworkStore.setState({ network: "testnet" });
    useDemolishStore.setState({
      sourceAddress: source.publicKey(),
      destinationAddress: Keypair.random().publicKey(),
      memo,
      memoType,
      mediatorRequired: false,
      accountState: {
        signers: [{ key: source.publicKey(), weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 0, med: 0, high: 0 },
      } as never,
    } as never);
    const bodies: unknown[] = [];
    spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async (body: unknown) => {
      bodies.push(body);
      throw new Error("stop after the request");
    }) as unknown as typeof closeClient.fetchCloseTransactions);

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(source));
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ memo: memo ?? undefined });
    expect((bodies[0] as { memoType?: string }).memoType).toBe(sent);
  }
);

function unsignedMergeWithMemoXdr(sourceKeypair: Keypair, destination: string, memo: Memo): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.accountMerge({ destination }));
  builder.addMemo(memo);
  return builder.build().toXdr();
}

test.each([
  ["id", "id", false],
  ["text", "text", false],
  ["id", "text", true],
  ["text", "id", true],
] as const)(
  "useCloseExecution › a %p memo the user chose, built by the API as %p, is refused before signing: %p",
  async (memoType, builtType, refused) => {
    const built = builtType === "id" ? Memo.id("4411") : Memo.text("4411");
    const source = Keypair.random();
    const destination = Keypair.random().publicKey();
    useNetworkStore.setState({ network: "testnet" });
    useDemolishStore.setState({
      sourceAddress: source.publicKey(),
      destinationAddress: destination,
      memo: "4411",
      memoType,
      mediatorRequired: false,
      phase: "STEP_EXECUTING",
      lastError: null,
      accountState: {
        signers: [{ key: source.publicKey(), weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 0, med: 0, high: 0 },
      } as never,
    } as never);
    const bodies: unknown[] = [];
    stubFetchCloseTransactions((async (body: unknown) => {
      bodies.push(body);
      return {
        planHash: "h",
        status: "ready",
        transactions: [
          {
            id: "t0",
            order: 0,
            xdr: unsignedMergeWithMemoXdr(source, destination, built),
            covers: ["MERGE"],
          },
        ],
        remaining: { steps: 0, requiresAnotherCall: false },
      };
    }) as never);
    let signCalls = 0;
    let submitCalls = 0;
    stubSubmitViaApi(async () => {
      submitCalls++;
      return {};
    });
    const signer = realSigner(source);
    const counting: TransactionSigner = {
      publicKey: signer.publicKey,
      sign: async (...args) => {
        signCalls++;
        return signer.sign(...args);
      },
    };

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(counting);
    });

    expect((bodies[0] as { memoType?: string }).memoType).toBe(memoType);
    if (!refused) {
      expect(useDemolishStore.getState().lastError).toBeNull();
      expect(useDemolishStore.getState().phase).toBe("COMPLETE");
      expect(submitCalls).toBe(1);
    } else {
      expect(useDemolishStore.getState().lastError).toContain(
        "This transaction doesn't match what you approved, so it was not signed or sent."
      );
      expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
      expect(signCalls).toBe(0);
      expect(submitCalls).toBe(0);
    }
  }
);

describe("useCloseExecution › a transfer destination the registry lists", () => {
  const ISSUER = Keypair.random().publicKey();
  const USDC = `USDC:${ISSUER}`;
  const PAYEE = Keypair.random().publicKey();
  let before: ReturnType<typeof activeRegistry>;

  beforeEach(() => {
    before = activeRegistry();
  });
  afterEach(() => setRegistry(before));

  const listPayee = (): void =>
    setRegistry({
      ...before,
      entries: [
        ...before.entries,
        {
          address: PAYEE,
          name: "Example Exchange",
          domain: "example.com",
          requiresMediator: false,
          requiresMemo: true,
          memoType: "text",
        },
      ],
    });

  function closing(sourceKeypair: Keypair): void {
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
      assetDispositions: { [USDC]: "transfer" },
      transferDestinations: { [USDC]: PAYEE },
      accountState: {
        signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 1, med: 1, high: 1 },
      } as never,
    } as never);
  }

  test("listed before the first round, nothing is fetched and the plan goes back for a new answer", async () => {
    const sourceKeypair = Keypair.random();
    closing(sourceKeypair);
    listPayee();
    let fetches = 0;
    stubFetchCloseTransactions(async () => {
      fetches++;
      throw new Error("must not be fetched");
    });

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });

    const state = useDemolishStore.getState();
    expect(fetches).toBe(0);
    expect(state.phase).not.toBe("STEP_FAILED");
    expect(state.executionPlan).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.planChangedNotice).toBe(TRANSFER_DESTINATION_REFUSED_NOTICE);
    expect(state.transferDestinations).toEqual({ [USDC]: PAYEE });
  });

  test("listed after a round was submitted, the next round is never fetched", async () => {
    const sourceKeypair = Keypair.random();
    closing(sourceKeypair);
    const round = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: "note", value: null }))
      .setTimeout(300)
      .build()
      .toXdr();
    let fetches = 0;
    stubFetchCloseTransactions(async () => {
      fetches++;
      return {
        planHash: "h",
        status: "ready",
        transactions: [{ id: "t0", order: 0, xdr: round, covers: ["REMOVE_DATA_ENTRIES"] }],
        remaining: { steps: 1, requiresAnotherCall: true },
      };
    });
    const submitted: string[] = [];
    stubSubmitViaApi(async (xdr) => {
      submitted.push(xdr as string);
      listPayee();
      return {};
    });

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });

    expect(submitted).toHaveLength(1);
    expect(fetches).toBe(1);
    expect(useDemolishStore.getState().planChangedNotice).toBe(TRANSFER_DESTINATION_REFUSED_NOTICE);
  });
});

/** Every status each step held during a run, in order, without repeats. */
function recordStatuses(): () => Record<string, string[]> {
  const seen: Record<string, string[]> = {};
  const note = (): void => {
    for (const step of useDemolishStore.getState().executionPlan) {
      const list = (seen[step.type] ??= []);
      if (list[list.length - 1] !== step.status) list.push(step.status);
    }
  };
  note();
  const unsubscribe = useDemolishStore.subscribe(note);
  return () => {
    unsubscribe();
    return seen;
  };
}

/** Holds a stand-in at `hold()` until the test calls `open()`; `reached` says it got there. */
function gateAt(): { hold: () => Promise<void>; reached: Promise<void>; open: () => void } {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    hold: () => {
      reach();
      return opened;
    },
    reached,
    open: () => open(),
  };
}

test("useCloseExecution › each step moves through signing, submitted and confirmed, and a later failure marks only its own steps", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "pending"),
    planStep(1, "MERGE", "pending"),
  ]);
  const signGates = [gateAt(), gateAt()];
  const submitGate = gateAt();
  stubSubmitViaApi(async () => {
    await submitGate.hold();
    return {};
  });
  const real = realSigner(sourceKeypair);
  let calls = 0;
  const signer: TransactionSigner = {
    publicKey: real.publicKey,
    sign: async (xdr, passphrase) => {
      const at = calls++;
      await signGates[at].hold();
      if (at === 1) throw USER_DECLINED;
      return real.sign(xdr, passphrase);
    },
  };
  const statuses = recordStatuses();
  const { result } = renderHook(() => useCloseExecution());
  const line = (): string | null =>
    result.current.progress ? progressLine(result.current.progress) : null;

  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(signer);
    await signGates[0].reached;
  });
  // Round one asked for another round, so its count is a floor.
  expect(line()).toBe("Transaction 1 of at least 1: signing with your key");
  expect(useDemolishStore.getState().executionPlan[0].status).toBe("signing");

  await act(async () => {
    signGates[0].open();
    await submitGate.reached;
  });
  expect(line()).toBe(
    "Transaction 1 of at least 1: confirming on Stellar (usually under 10 seconds)"
  );
  expect(useDemolishStore.getState().executionPlan[0].status).toBe("submitted");

  await act(async () => {
    submitGate.open();
    await signGates[1].reached;
  });
  expect(line()).toBe("Transaction 2 of 2: signing with your key");

  await act(async () => {
    signGates[1].open();
    await running;
  });

  expect(statuses()).toEqual({
    NORMALIZE_SIGNERS: ["pending", "signing", "submitted", "confirmed"],
    MERGE: ["pending", "signing", "failed"],
  });
  const plan = useDemolishStore.getState().executionPlan;
  expect(plan[0].txHash).not.toBeNull();
  expect(plan[1].error).toBe(useDemolishStore.getState().lastError);
  expect(result.current.progress).toBeNull();
});

test("useCloseExecution › a retry numbers its transactions after the ones already confirmed, and clears the failed step", async () => {
  const { sourceKeypair } = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "confirmed"),
    { ...(planStep(1, "MERGE", "failed") as object), error: "declined" },
  ]);
  stubSubmitViaApi(async () => ({}));
  const signGate = gateAt();
  const real = realSigner(sourceKeypair);
  const signer: TransactionSigner = {
    publicKey: real.publicKey,
    sign: async (xdr, passphrase) => {
      await signGate.hold();
      return real.sign(xdr, passphrase);
    },
  };
  const statuses = recordStatuses();
  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(signer);
    await signGate.reached;
  });
  // planStep gives the confirmed step hash0: one transaction of this close came before.
  expect(progressLine(result.current.progress!)).toBe("Transaction 2 of 2: signing with your key");
  await act(async () => {
    signGate.open();
    await running;
  });
  expect(statuses().MERGE).toEqual(["failed", "pending", "signing", "submitted", "confirmed"]);
});

test("useCloseExecution › a round paused for another signer puts its steps back to waiting, not failed", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    executionPlan: [planStep(0, "MERGE", "pending")],
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: Keypair.random().publicKey(), weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  const mergeXdr = unsignedMergeXdr(sourceKeypair, destination);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));
  const statuses = recordStatuses();
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });

  expect(result.current.signatureStatus).not.toBeNull();
  expect(statuses().MERGE).toEqual(["pending", "signing", "pending"]);
});

/** A left-over submission of the first round, still marked sent in the step list. */
function leftOverSetup(): { sourceKeypair: Keypair } {
  const setup = twoRoundSetup([
    planStep(0, "NORMALIZE_SIGNERS", "submitted"),
    planStep(1, "MERGE", "pending"),
  ]);
  spyOn(recovery, "findUnresolved").mockResolvedValue(null);
  useDemolishStore.setState({
    unconfirmedSubmission: {
      hash: "e".repeat(64),
      covers: ["NORMALIZE_SIGNERS"],
      validUntil: 1_000,
    },
  } as never);
  return setup;
}

test("useCloseExecution › a left-over found failed at the start marks its steps failed, not sent", async () => {
  const { sourceKeypair } = leftOverSetup();
  stubLookup(async (hash) => ({ status: "failed", hash, message: "tx_bad_seq" }));
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.executionPlan.map((s) => s.status)).toEqual(["failed", "pending"]);
});

test("useCloseExecution › a left-over found expired puts its steps back to waiting before the run goes on", async () => {
  const { sourceKeypair } = leftOverSetup();
  stubLookup(async (hash) => ({ status: "not_found", hash, searched: SEARCHED }));
  stubFetchCloseTransactions(async () => {
    throw new ApiRequestError(503, "");
  });
  const statuses = recordStatuses();
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  // Expired, the run fetched a fresh round; that fetch failing leaves the step waiting.
  expect(statuses().NORMALIZE_SIGNERS).toEqual(["submitted", "pending"]);
  expect(useDemolishStore.getState().unconfirmedSubmission).toBeNull();
});

test("useCloseExecution › a wallet that never answers ends in the timeout copy, clears the busy state and sends nothing", async () => {
  const { sourceKeypair } = mergeSetup();
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits += 1;
    return {};
  });
  let expire = (): void => {};
  let late = (_: { signedTxXdr: string }): void => {};
  const started: number[] = [];
  const signer = new WalletKitSigner(
    sourceKeypair.publicKey(),
    () => new Promise((resolve) => (late = resolve)),
    {
      walletId: WALLET_CONNECT_WALLET_ID,
      startTimeout: (ms) => {
        started.push(ms);
        return { expired: new Promise<void>((resolve) => (expire = resolve)), cancel: () => {} };
      },
    }
  );

  const { result } = renderHook(() => useCloseExecution());
  let running!: Promise<void>;
  await act(async () => {
    running = result.current.run(signer);
    while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(progressLine(result.current.progress!)).toBe(
    "Transaction 1 of 1: approve in your wallet app"
  );

  await act(async () => {
    expire();
    await running;
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.lastError?.startsWith(WALLET_TIMED_OUT)).toBe(true);
  expect(state.lastError).not.toMatch(/No new transaction was sent/);
  expect(state.signingRun).toBe(false);
  expect(result.current.progress).toBeNull();
  expect(result.current.retrySafe).toBe(true);
  expect(state.executionPlan[0].status).toBe("failed");

  // The wallet answering now changes nothing: no send, no state.
  await act(async () => {
    late({ signedTxXdr: "late" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(submits).toBe(0);
  expect(useDemolishStore.getState().lastError).toBe(state.lastError);
});

/** The API's answer for a transaction the network refused as tx_too_late. */
const TOO_LATE = new ApiRequestError(
  422,
  "Transaction expired before it was confirmed. Please retry.",
  undefined,
  "submit_rejected"
);

test("useCloseExecution › a tx_too_late refusal reads as a refusal, and adds the clock hint when this device called it expired", async () => {
  const { sourceKeypair } = mergeSetup();
  stubSubmitViaApi(async () => {
    throw TOO_LATE;
  });
  // Ten minutes fast: past the 300 s the merge was built for.
  const realNow = Date.now;
  spyOn(Date, "now").mockImplementation(() => realNow() + 600_000);
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  const state = useDemolishStore.getState();
  expect(state.phase).toBe("STEP_FAILED");
  expect(state.unconfirmedSubmission).toBeNull();
  expect(state.lastError).toMatch(/^Transaction expired before it was confirmed/);
  expect(state.lastError).toMatch(/Its operations did not take effect, so it is safe to retry/);
  expect(state.lastError?.endsWith(CLOCK_HINT)).toBe(true);
  expect(state.executionPlan[0].status).toBe("failed");
  expect(result.current.retrySafe).toBe(true);
});

test("useCloseExecution › a tx_too_late refusal on a correct clock has no clock hint", async () => {
  const { sourceKeypair } = mergeSetup();
  stubSubmitViaApi(async () => {
    throw TOO_LATE;
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().lastError).toMatch(/Its operations did not take effect/);
  expect(useDemolishStore.getState().lastError).not.toContain(CLOCK_HINT);
});

// #402: the reported-account check in WalletKitSigner is a pre-check only. A wallet that reports
// no signing account and signs with another key is still refused by the weight check after
// signing, before anything is submitted.
test("useCloseExecution › a wallet that signs with another key and reports nothing is refused by the weight check", async () => {
  const sourceKeypair = Keypair.random();
  const other = Keypair.random();
  const source = sourceKeypair.publicKey();
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
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 0, high: 0 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  }));
  const submitted: unknown[] = [];
  stubSubmitViaApi(async (xdr) => {
    submitted.push(xdr);
    return { txHash: "never" };
  });

  const wallet = new WalletKitSigner(source, async (xdr, opts) => {
    const tx = TransactionBuilder.fromXdr(xdr, opts.networkPassphrase);
    tx.sign(other);
    return { signedTxXdr: tx.toEnvelope().toXdr("base64") };
  });
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(wallet);
  });

  expect(useDemolishStore.getState().lastError).toMatch(/didn't add a new signature/);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(submitted).toHaveLength(0);
});

// The post-sign check requires the named signer's own signature, not only more weight: a wallet
// that reports no signing account and signs with another of the account's own signer keys would
// otherwise be counted as the named key.
describe("useCloseExecution › the named signer's own signature after signing", () => {
  function ownSignatureSetup(
    signers: { key: string; weight: number; type: string }[],
    thresholds: { low: number; med: number; high: number },
    sourceKeypair: Keypair
  ): { submitted: string[]; cosigns: () => number } {
    const destination = Keypair.random().publicKey();
    const mergeXdr = unsignedMergeXdr(sourceKeypair, destination);
    useNetworkStore.setState({ network: "testnet" });
    useDemolishStore.setState({
      sourceAddress: sourceKeypair.publicKey(),
      destinationAddress: destination,
      memo: null,
      mediatorRequired: false,
      lastError: null,
      accountState: { signers, thresholds } as never,
    } as never);
    stubFetchCloseTransactions(async () => ({
      planHash: "h",
      status: "ready",
      transactions: [{ id: "t0", order: 0, xdr: mergeXdr, covers: ["MERGE"] }],
      remaining: { steps: 0, requiresAnotherCall: false },
    }));
    const submitted: string[] = [];
    stubSubmitViaApi(async (xdr) => {
      submitted.push(xdr as string);
      return {};
    });
    const cosign = spyOn(mediatorModule, "requestMediatorCosignature");
    return { submitted, cosigns: () => cosign.mock.calls.length };
  }

  /** A wallet named for `named` that signs with `keys` and reports no signing account. */
  function walletSigningWith(named: string, keys: Keypair[]): WalletKitSigner {
    return new WalletKitSigner(named, async (xdr, opts) => {
      const tx = TransactionBuilder.fromXdr(xdr, opts.networkPassphrase);
      for (const key of keys) tx.sign(key);
      return { signedTxXdr: tx.toEnvelope().toXdr("base64") };
    });
  }

  const ed25519 = (key: string, weight = 1) => ({ key, weight, type: "ed25519_public_key" });

  test("a wallet named for one signer that signs with another signer key is refused, naming the key that signed", async () => {
    const sourceKeypair = Keypair.random();
    const cosigner = Keypair.random().publicKey();
    const source = sourceKeypair.publicKey();
    // Weight 1 is enough, so a weight-only check would have submitted this.
    const { submitted, cosigns } = ownSignatureSetup(
      [ed25519(source), ed25519(cosigner)],
      { low: 1, med: 1, high: 1 },
      sourceKeypair
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(walletSigningWith(cosigner, [sourceKeypair]));
    });

    expect(useDemolishStore.getState().lastError).toContain(
      walletAccountMismatch(source, cosigner)
    );
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    expect(submitted).toHaveLength(0);
    expect(cosigns()).toBe(0);
  });

  test("on a resumed round, a wallet named for a third signer that signs with the second is refused", async () => {
    const sourceKeypair = Keypair.random();
    const secondKeypair = Keypair.random();
    const third = Keypair.random().publicKey();
    const source = sourceKeypair.publicKey();
    const second = secondKeypair.publicKey();
    const { submitted } = ownSignatureSetup(
      [ed25519(source), ed25519(second), ed25519(third)],
      { low: 1, med: 2, high: 2 },
      sourceKeypair
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });
    expect(result.current.signatureStatus?.accumulatedWeight).toBe(1);

    await act(async () => {
      await result.current.run(walletSigningWith(third, [secondKeypair]));
    });

    expect(useDemolishStore.getState().lastError).toContain(walletAccountMismatch(second, third));
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    // A refusal, not a pause: the partly signed round is not kept, as for any non-weight error.
    expect(result.current.signatureStatus).toBeNull();
    expect(submitted).toHaveLength(0);
  });

  test("a wallet that reports nothing and signs with the named key is accepted", async () => {
    const sourceKeypair = Keypair.random();
    const cosignerKeypair = Keypair.random();
    const source = sourceKeypair.publicKey();
    const cosigner = cosignerKeypair.publicKey();
    const { submitted } = ownSignatureSetup(
      [ed25519(source), ed25519(cosigner)],
      { low: 1, med: 1, high: 1 },
      sourceKeypair
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(walletSigningWith(cosigner, [cosignerKeypair]));
    });

    expect(useDemolishStore.getState().lastError).toBeNull();
    expect(useDemolishStore.getState().phase).toBe("COMPLETE");
    expect(submitted).toHaveLength(1);
  });

  test("a wallet that adds the named key's signature and another signer key's is accepted", async () => {
    const sourceKeypair = Keypair.random();
    const cosignerKeypair = Keypair.random();
    const source = sourceKeypair.publicKey();
    const cosigner = cosignerKeypair.publicKey();
    const { submitted } = ownSignatureSetup(
      [ed25519(source), ed25519(cosigner)],
      { low: 2, med: 2, high: 2 },
      sourceKeypair
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(walletSigningWith(cosigner, [cosignerKeypair, sourceKeypair]));
    });

    expect(useDemolishStore.getState().lastError).toBeNull();
    expect(useDemolishStore.getState().phase).toBe("COMPLETE");
    expect(submitted).toHaveLength(1);
  });

  test("a wallet named for a key that adds only a hash(x) preimage is refused", async () => {
    const sourceKeypair = Keypair.random();
    const cosigner = Keypair.random().publicKey();
    const source = sourceKeypair.publicKey();
    const preimage = new Uint8Array(32).fill(7);
    // The preimage alone carries enough weight, so a weight-only check would have submitted it.
    const { submitted } = ownSignatureSetup(
      [
        ed25519(source),
        ed25519(cosigner),
        { key: StrKey.encodeSha256Hash(hash(Buffer.from(preimage))), weight: 1, type: "hash_x" },
      ],
      { low: 1, med: 1, high: 1 },
      sourceKeypair
    );
    const wallet = new WalletKitSigner(cosigner, async (xdr, opts) => {
      const tx = TransactionBuilder.fromXdr(xdr, opts.networkPassphrase);
      tx.signHashX(Buffer.from(preimage));
      return { signedTxXdr: tx.toEnvelope().toXdr("base64") };
    });

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(wallet);
    });

    expect(useDemolishStore.getState().lastError).toMatch(/didn't add a new signature/);
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    expect(submitted).toHaveLength(0);
  });

  test("the named key's own signature that adds no weight is still refused by the weight check", async () => {
    const sourceKeypair = Keypair.random();
    const cosigner = Keypair.random().publicKey();
    const source = sourceKeypair.publicKey();
    const { submitted } = ownSignatureSetup(
      [ed25519(source, 0), ed25519(cosigner)],
      { low: 1, med: 1, high: 1 },
      sourceKeypair
    );

    const { result } = renderHook(() => useCloseExecution());
    await act(async () => {
      await result.current.run(realSigner(sourceKeypair));
    });

    expect(useDemolishStore.getState().lastError).toMatch(/didn't add a new signature/);
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    expect(submitted).toHaveLength(0);
  });
});

// #402: a wallet that stops being usable between two transactions of a run stops the run before
// its second prompt, with nothing more sent.
test("useCloseExecution › a wallet on another network by the second transaction is not asked again", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const normalizeXdr = unsignedNormalizeXdr(sourceKeypair, [cosigner], "100");
  const mergeXdr = new TransactionBuilder(new Account(source, "101"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(300)
    .addOperation(Operation.accountMerge({ destination }))
    .build()
    .toXdr();
  const roundSigners = {
    signers: [
      { key: source, weight: 1, type: "ed25519_public_key" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 1, high: 1 },
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
  stubFetchCloseTransactions(async () => ({
    planHash: "h",
    status: "ready",
    transactions: [
      { id: "t0", order: 0, xdr: normalizeXdr, covers: ["NORMALIZE_SIGNERS"] },
      { id: "t1", order: 1, xdr: mergeXdr, covers: ["MERGE"] },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
    sourceAccount: roundSigners,
  }));
  const submitted: string[] = [];
  stubSubmitViaApi(async (xdr) => {
    submitted.push(xdr as string);
    return { txHash: `hash-${submitted.length}` };
  });

  let prompts = 0;
  const wallet = realSigner(sourceKeypair);
  const counted: TransactionSigner = {
    publicKey: wallet.publicKey,
    sign: (xdr, passphrase) => {
      prompts++;
      return wallet.sign(xdr, passphrase);
    },
  };
  let checks = 0;
  const beforeSign = async (): Promise<void> => {
    checks++;
    // Usable for the first signature; on another network by the second.
    if (checks > 1) throw new WalletNotUsableError("network", "testnet");
  };

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(counted, { beforeSign });
  });

  expect(checks).toBe(2);
  expect(prompts).toBe(1);
  expect(submitted).toHaveLength(1);
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(useDemolishStore.getState().lastError).toContain(walletNotUsable("network", "testnet"));
});

// #401: a run with no signer, as after a pre-authorized transaction, re-reads the account and
// builds the next round, but can never submit: every transaction needs weight 1 or more.
test("useCloseExecution › a run with no signer pauses with a status and submits nothing", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
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
  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [
        {
          id: "t0",
          order: 0,
          xdr: unsignedMergeXdr(sourceKeypair, destination),
          covers: ["MERGE"],
        },
      ],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits++;
    return { txHash: "never" };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(null);
  });

  expect(fetches).toBe(1);
  expect(submits).toBe(0);
  expect(result.current.signatureStatus).toEqual({
    requiredWeight: 1,
    accumulatedWeight: 0,
    contributed: [],
    remainingSigners: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    notice: null,
  });
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
});

/** A 2-of-3 account whose third signer pre-authorized a transaction removing the cosigner. The
 *  round on the API is a merge at sequence 101, paused after the master key signed it. */
async function pausedWithPreAuthSigner(preAuthSequence: string) {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const cosigner = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const preAuthXdr = unsignedNormalizeXdr(sourceKeypair, [cosigner], preAuthSequence);
  const preAuthKey = StrKey.encodePreAuthTx(
    (TransactionBuilder.fromXdr(preAuthXdr, Networks.TESTNET) as Transaction).hash()
  );
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
        { key: preAuthKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  const counts = { fetches: 0, submits: 0 };
  stubFetchCloseTransactions(async () => {
    counts.fetches++;
    return {
      planHash: "h",
      status: "ready",
      transactions: [
        {
          id: "t0",
          order: 0,
          xdr: unsignedMergeXdr(sourceKeypair, destination),
          covers: ["MERGE"],
        },
      ],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });
  stubSubmitViaApi(async () => {
    counts.submits++;
    return { txHash: "server-hash" };
  });
  const hook = renderHook(() => useCloseExecution());
  await act(async () => {
    await hook.result.current.run(realSigner(sourceKeypair));
  });
  expect(hook.result.current.signatureStatus?.accumulatedWeight).toBe(1);
  const preAuthSigner = { key: preAuthKey, weight: 1, type: "preauth_tx" as const };
  return { hook, counts, preAuthXdr, preAuthSigner };
}

test("useCloseExecution › after a pre-authorized transaction with no wallet or key, the close continues with the next round", async () => {
  // Sequence 100 + 1: the same number the paused round needs, now used up on the ledger.
  const { hook, counts, preAuthXdr, preAuthSigner } = await pausedWithPreAuthSigner("100");

  let submission: { hash: string; closedAccount: boolean } | undefined;
  await act(async () => {
    submission = await hook.result.current.submitPreAuthTransaction(preAuthSigner, preAuthXdr);
  });
  expect(submission).toEqual({
    hash: submissionHash(preAuthXdr, Networks.TESTNET),
    closedAccount: false,
  });
  expect(counts.submits).toBe(1);

  await act(async () => {
    await hook.result.current.run(null);
  });
  // The dead round was dropped, so the account was read again for the next one.
  expect(counts.fetches).toBe(2);
  expect(counts.submits).toBe(1);
  expect(hook.result.current.signatureStatus).not.toBeNull();
});

test("useCloseExecution › a pre-authorized transaction that did not use the round's sequence keeps the partly signed round", async () => {
  // Sequence 50 + 1, below the paused round's 101: that round can still land.
  const { hook, counts, preAuthXdr, preAuthSigner } = await pausedWithPreAuthSigner("50");

  await act(async () => {
    await hook.result.current.submitPreAuthTransaction(preAuthSigner, preAuthXdr);
  });
  await act(async () => {
    await hook.result.current.run(null);
  });
  // Resumed onto the same envelope, which still carries the master key's signature.
  expect(counts.fetches).toBe(1);
  expect(counts.submits).toBe(1);
  expect(hook.result.current.signatureStatus?.accumulatedWeight).toBe(1);
});

test("useCloseExecution › a pre-authorized merge completes the close with its own hash", async () => {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const preAuthXdr = unsignedMergeXdr(sourceKeypair, destination);
  const preAuthKey = StrKey.encodePreAuthTx(
    (TransactionBuilder.fromXdr(preAuthXdr, Networks.TESTNET) as Transaction).hash()
  );
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    executionPlan: [{ id: "m", type: "MERGE", status: "pending" } as never],
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: preAuthKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  stubSubmitViaApi(async () => ({ txHash: "server-hash" }));

  const { result } = renderHook(() => useCloseExecution());
  let submission: { hash: string; closedAccount: boolean } | undefined;
  await act(async () => {
    submission = await result.current.submitPreAuthTransaction(
      { key: preAuthKey, weight: 1, type: "preauth_tx" },
      preAuthXdr
    );
  });

  const hash = submissionHash(preAuthXdr, Networks.TESTNET);
  expect(submission).toEqual({ hash, closedAccount: true });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(useDemolishStore.getState().executionPlan[0]).toMatchObject({
    status: "confirmed",
    txHash: hash,
  });
});

test("useCloseExecution › an API answering a pre-authorized submission with another hash settles nothing", async () => {
  const { hook, counts, preAuthXdr, preAuthSigner } = await pausedWithPreAuthSigner("100");
  stubSubmitViaApi(async () => {
    counts.submits++;
    return { wrongHash: "f".repeat(64) };
  });

  const local = submissionHash(preAuthXdr, Networks.TESTNET);
  let error: unknown;
  await act(async () => {
    await hook.result.current
      .submitPreAuthTransaction(preAuthSigner, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  // Told to look up the local hash, never the one the API reported, and held until it settles.
  expect(String((error as Error)?.message)).toContain(`Look up ${local}`);
  expect(String((error as Error)?.message)).not.toContain("f".repeat(64));
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(useDemolishStore.getState().unconfirmedSubmission?.hash).toBe(local);
  expect(useDemolishStore.getState().signingRun).toBe(false);
});

/** A pre-authorized transaction of an account with a pre-auth signer, ready to submit. Checks
 *  are stubbed out: these tests are about what happens around the submission. */
function preAuthSetup(ops: xdr.Operation[], plan: unknown[]) {
  const sourceKeypair = Keypair.random();
  const source = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const builder = new TransactionBuilder(new Account(source, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  ops.forEach((op) => builder.addOperation(op));
  const preAuthXdr = builder.build().toXdr();
  const preAuthKey = StrKey.encodePreAuthTx(
    (TransactionBuilder.fromXdr(preAuthXdr, Networks.TESTNET) as Transaction).hash()
  );
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: source,
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    phase: "STEP_FAILED",
    signingRun: false,
    unconfirmedSubmission: null,
    executionPlan: plan,
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: preAuthKey, weight: 1, type: "preauth_tx" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  const signer = { key: preAuthKey, weight: 1, type: "preauth_tx" as const };
  return { source, destination, preAuthXdr, signer };
}

test("useCloseExecution › a pre-authorized merge the API answers with another hash does not complete", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  stubSubmitViaApi(async () => ({ wrongHash: "f".repeat(64) }));

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.submitPreAuthTransaction(signer, preAuthXdr).catch(() => {});
  });

  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");
  expect(useDemolishStore.getState().executionPlan[0]?.status).toBe("pending");
});

test("useCloseExecution › a pre-authorized submission with no answer is held as unconfirmed, and Check again settles it", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  stubSubmitViaApi(async () => {
    throw new ApiRequestError(504, "");
  });

  const { result } = renderHook(() => useCloseExecution());
  let error: unknown;
  await act(async () => {
    await result.current
      .submitPreAuthTransaction(signer, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  const hash = submissionHash(preAuthXdr, Networks.TESTNET);
  expect(String((error as Error)?.message)).toContain(`Look up ${hash}`);
  const held = useDemolishStore.getState().unconfirmedSubmission;
  expect(held?.hash).toBe(hash);
  // The steps its operations cover, as the close's own submissions record them.
  expect(held?.covers).toEqual(["MERGE", "CLOSE_ACCOUNT"]);
  expect(useDemolishStore.getState().phase).toBe("STEP_UNCONFIRMED");

  stubLookup(async (h) => ({ status: "confirmed", hash: h, ledger: 9 }));
  await act(async () => {
    await result.current.checkUnconfirmed();
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(useDemolishStore.getState().unconfirmedSubmission).toBeNull();
});

test("useCloseExecution › a pre-authorized submission the network refuses is a refusal: sent once, its reason surfaced, nothing held", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  const reason =
    "The signatures on this transaction do not reach the signing weight the account requires.";
  const refusal = new ApiRequestError(422, reason, undefined, "submit_rejected");
  let sends = 0;
  stubSubmitViaApi(async () => {
    sends++;
    throw refusal;
  });

  const { result } = renderHook(() => useCloseExecution());
  let error: unknown;
  await act(async () => {
    await result.current
      .submitPreAuthTransaction(signer, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  expect(error).toBe(refusal);
  expect(sends).toBe(1);
  expect(useDemolishStore.getState().unconfirmedSubmission).toBeNull();
  expect(useDemolishStore.getState().phase).not.toBe("STEP_UNCONFIRMED");
});

test("useCloseExecution › an account switched during a pre-authorized submission gets nothing written into it", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  const other = Keypair.random().publicKey();
  const otherPlan = [planStep(0, "MERGE", "pending")];
  stubSubmitViaApi(async (xdr) => {
    // Another account is started in this tab while the answer is on its way.
    useDemolishStore.setState({
      sourceAddress: other,
      phase: "PREFLIGHT_COMPLETE",
      executionPlan: otherPlan,
      unconfirmedSubmission: null,
      signingRun: false,
    } as never);
    return { txHash: submissionHash(xdr as string, Networks.TESTNET) };
  });

  const { result } = renderHook(() => useCloseExecution());
  let error: unknown;
  await act(async () => {
    await result.current
      .submitPreAuthTransaction(signer, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  expect(String((error as Error)?.message)).toBe(CLOSE_INTERRUPTED);
  const state = useDemolishStore.getState();
  expect(state.sourceAddress).toBe(other);
  expect(state.phase).toBe("PREFLIGHT_COMPLETE");
  expect(state.executionPlan).toEqual(otherPlan as never);
  expect(state.unconfirmedSubmission).toBeNull();
  expect(state.signingRun).toBe(false);
});

test("useCloseExecution › a landed pre-authorized transaction marks every step its operations cover", async () => {
  const issuer = Keypair.random().publicKey();
  const usdc = new Asset("USDC", issuer);
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [
      Operation.payment({ destination, asset: usdc, amount: "1" }),
      Operation.changeTrust({ asset: usdc, limit: "0" }),
      Operation.accountMerge({ destination }),
    ],
    [
      { ...(planStep(0, "HANDLE_ASSETS", "pending") as object), affectedAsset: `USDC:${issuer}` },
      { ...(planStep(1, "HANDLE_ASSETS", "pending") as object), affectedAsset: `EURC:${issuer}` },
      planStep(2, "REMOVE_TRUSTLINES", "pending"),
      planStep(3, "CLOSE_ACCOUNT", "pending"),
      planStep(4, "MERGE", "pending"),
    ]
  );
  stubSubmitViaApi(async () => ({}));

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.submitPreAuthTransaction(signer, preAuthXdr);
  });

  const hash = submissionHash(preAuthXdr, Networks.TESTNET);
  const plan = useDemolishStore.getState().executionPlan;
  expect(plan.map((s) => [s.type, s.affectedAsset ?? null, s.status, s.txHash ?? null])).toEqual([
    ["HANDLE_ASSETS", `USDC:${issuer}`, "confirmed", hash],
    // Another asset's step of the same type is not this transaction's.
    ["HANDLE_ASSETS", `EURC:${issuer}`, "pending", null],
    ["REMOVE_TRUSTLINES", null, "confirmed", hash],
    ["CLOSE_ACCOUNT", null, "confirmed", hash],
    ["MERGE", null, "confirmed", hash],
  ]);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("useCloseExecution › a signer run is refused while a pre-authorized submission is in flight", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  let answer: (value: unknown) => void = () => {};
  stubSubmitViaApi(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  let fetches = 0;
  stubFetchCloseTransactions(async () => {
    fetches++;
    throw new ApiRequestError(500, "");
  });

  const { result } = renderHook(() => useCloseExecution());
  let submitting: Promise<unknown> = Promise.resolve();
  await act(async () => {
    submitting = result.current.submitPreAuthTransaction(signer, preAuthXdr);
    await Promise.resolve();
  });
  await waitForSigningRun(true);
  await act(async () => {
    await result.current.run(realSigner(Keypair.random()));
  });
  expect(fetches).toBe(0);

  await act(async () => {
    answer({});
    await submitting;
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(useDemolishStore.getState().signingRun).toBe(false);
});

async function waitForSigningRun(value: boolean): Promise<void> {
  for (let i = 0; i < 50 && useDemolishStore.getState().signingRun !== value; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(useDemolishStore.getState().signingRun).toBe(value);
}

test("useCloseExecution › a run that fails after the close completed leaves it complete", async () => {
  const sourceKeypair = Keypair.random();
  const destination = Keypair.random().publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: sourceKeypair.publicKey(),
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    phase: "STEP_FAILED",
    signingRun: false,
    accountState: {
      signers: [{ key: sourceKeypair.publicKey(), weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => {
    // A pre-authorized merge completed the close while this round was being read.
    useDemolishStore.setState({ phase: "COMPLETE" } as never);
    throw new ApiRequestError(500, "");
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("useCloseExecution › a run that ends without a merge after the close completed leaves it complete", async () => {
  const sourceKeypair = Keypair.random();
  const destination = Keypair.random().publicKey();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: sourceKeypair.publicKey(),
    destinationAddress: destination,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    phase: "STEP_FAILED",
    signingRun: false,
    accountState: {
      signers: [{ key: sourceKeypair.publicKey(), weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  stubFetchCloseTransactions(async () => {
    useDemolishStore.setState({ phase: "COMPLETE" } as never);
    return {
      planHash: "h",
      status: "ready",
      transactions: [],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  });

  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("useCloseExecution › a pre-authorized submission is refused while a run is in flight", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  useDemolishStore.setState({ signingRun: true } as never);
  let submits = 0;
  stubSubmitViaApi(async () => {
    submits++;
    return {};
  });

  const { result } = renderHook(() => useCloseExecution());
  let error: unknown;
  await act(async () => {
    await result.current
      .submitPreAuthTransaction(signer, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  expect(String((error as Error)?.message)).toContain(
    "Another step of this close is still running"
  );
  expect(submits).toBe(0);
  expect(useDemolishStore.getState().signingRun).toBe(true);
  useDemolishStore.setState({ signingRun: false } as never);
});

test("useCloseExecution › an account switched during a pre-authorized submission answered with another hash is left alone", async () => {
  const destination = Keypair.random().publicKey();
  const { preAuthXdr, signer } = preAuthSetup(
    [Operation.accountMerge({ destination })],
    [planStep(0, "MERGE", "pending")]
  );
  const other = Keypair.random().publicKey();
  stubSubmitViaApi(async () => {
    useDemolishStore.setState({
      sourceAddress: other,
      phase: "PREFLIGHT_COMPLETE",
      unconfirmedSubmission: null,
      signingRun: false,
    } as never);
    return { wrongHash: "f".repeat(64) };
  });

  const { result } = renderHook(() => useCloseExecution());
  let error: unknown;
  await act(async () => {
    await result.current
      .submitPreAuthTransaction(signer, preAuthXdr)
      .catch((err: unknown) => (error = err));
  });

  expect(String((error as Error)?.message)).toBe(CLOSE_INTERRUPTED);
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("useCloseExecution › a wallet is shown the hash of the very envelope it is asked to sign", async () => {
  const { sourceKeypair } = mergeSetup();
  const destination = useDemolishStore.getState().destinationAddress;
  stubSubmitViaApi(async () => ({}));
  const { result } = renderHook(() => useCloseExecution());
  const seen: { xdr: string; prompt: unknown }[] = [];
  const wallet = new WalletKitSigner(
    sourceKeypair.publicKey(),
    async (xdr) => {
      // The prompt is on screen while the wallet's own prompt is open.
      await waitFor(() => expect(result.current.signingPrompt).not.toBeNull());
      seen.push({ xdr, prompt: result.current.signingPrompt });
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(sourceKeypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: sourceKeypair.publicKey() };
    },
    { walletId: WALLET_CONNECT_WALLET_ID }
  );

  await result.current.run(wallet);

  expect(seen).toHaveLength(1);
  const asked = seen[0]!;
  expect(asked.prompt).toEqual({
    walletId: WALLET_CONNECT_WALLET_ID,
    hash: toHex(TransactionBuilder.fromXDR(asked.xdr, Networks.TESTNET).hash()),
    summary: { mergeDestination: destination, operationCount: 1 },
  });
  await waitFor(() => expect(result.current.signingPrompt).toBeNull());
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("useCloseExecution › the prompt goes when the wallet declines", async () => {
  const { sourceKeypair } = mergeSetup();
  const { result } = renderHook(() => useCloseExecution());
  let shown: unknown = null;
  const declining = new WalletKitSigner(
    sourceKeypair.publicKey(),
    async () => {
      await waitFor(() => expect(result.current.signingPrompt).not.toBeNull());
      shown = result.current.signingPrompt;
      throw USER_DECLINED;
    },
    { walletId: VARIAL_ID }
  );
  await result.current.run(declining);
  expect(shown).not.toBeNull();
  await waitFor(() => expect(result.current.signingPrompt).toBeNull());
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
});

test("useCloseExecution › a key signer never gets a wallet prompt", async () => {
  const { sourceKeypair } = mergeSetup();
  stubSubmitViaApi(async () => ({}));
  const built = spyOn(signingPromptModule, "signingPromptFor");
  const { result } = renderHook(() => useCloseExecution());
  await act(async () => {
    await result.current.run(realSigner(sourceKeypair));
  });
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
  expect(built).not.toHaveBeenCalled();
  expect(result.current.signingPrompt).toBeNull();
});
