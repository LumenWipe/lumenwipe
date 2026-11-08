import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Asset,
  hash,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import ExecutionWizard, {
  ALREADY_SIGNED,
  NOT_A_SIGNER,
  NOT_STILL_NEEDED,
  STALE_PROMPT_HOLD_MS,
} from "@/components/execution/ExecutionWizard";
import { useDemolishStore } from "@/store/demolish";
import { InvalidPreAuthTxError } from "@/lib/stellar/pre-auth-tx";
import * as navigation from "next/navigation";
import * as closeExecution from "@/hooks/useCloseExecution";
import type { PreAuthSubmission, RunOptions } from "@/hooks/useCloseExecution";
import * as walletKit from "@/hooks/useWalletKitConnection";
import * as sessionStore from "@/lib/session/store";
import { fromHex } from "@/lib/stellar/hex";
import {
  closeFailureMessage,
  PROGRESS_NOT_SAVED,
  UNCONFIRMED_NOTICE,
  walletAccountMismatch,
} from "@/lib/utils/user-error";
import {
  HashXPreimageSigner,
  SecretKeySigner,
  SignerReleasedError,
  WalletKitSigner,
  WalletNotUsableError,
  WalletSigningTimeoutError,
} from "@/lib/stellar/signer";
import * as activeSignerHook from "@/hooks/useActiveSigner";
import * as secretKeyInputModule from "@/components/account-entry/SecretKeyInput";
import * as walletKitClient from "@/lib/wallet-kit/client";
import type { CloseProgress } from "@/lib/execution/progress";
import { hashFingerprint, type SigningPrompt } from "@/lib/execution/signing-prompt";
import { expectFocused, expectFocusedNow, expectSameElement } from "./fixtures/focus";

const WAITING_LINE = "Transaction 1 of 1: approve in your wallet";

// ExecutionWizard calls useRouter() (to navigate to /complete on success) - outside of a
// real Next.js app router tree that throws "invariant expected app router to be mounted".
// This test never reaches the COMPLETE-phase navigation itself, so a no-op stub is enough.
//
// Every stand-in below is a spyOn on the real module object, installed per test and undone by
// mock.restore(): mock.module replaces a module for the whole `bun test` process, and the
// replacement of useCloseExecution here was reaching use-close-execution.test.tsx whenever this
// file ran first - Bun's file order differs between machines - so that file was testing this
// stub instead of the hook.
function stubRouter(): void {
  spyOn(navigation, "useRouter").mockImplementation(
    () => ({ push: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
}

// Mocks kept minimal and behavior-focused: this test exercises ExecutionWizard's own
// state machine (signature-progress rendering, signer switching, no persisted writes),
// not the full close pipeline - that's Task 3/4's job.
// A run with no signer (after a pre-authorized transaction) reaches it as null.
let runImpl: (signer: { publicKey: string }, options?: RunOptions) => Promise<void>;
let submitPreAuthTxImpl: (
  signer: { key: string; weight: number; type: string },
  xdr: string
) => Promise<PreAuthSubmission>;
function stubCloseExecution(): void {
  spyOn(closeExecution, "useCloseExecution").mockImplementation(
    () =>
      ({
        run: (signer: { publicKey: string } | null, options?: RunOptions) =>
          runImpl(signer as { publicKey: string }, options),
        progress: currentProgress,
        signatureStatus: currentSignatureStatus,
        signingPrompt: currentSigningPrompt,
        submitPreAuthTransaction: (
          signer: { key: string; weight: number; type: string },
          xdr: string
        ) => submitPreAuthTxImpl(signer, xdr),
        checkUnconfirmed: () => checkImpl(),
        retrySafe: currentRetrySafe,
        stillUnconfirmed: currentStillUnconfirmed,
      }) as unknown as ReturnType<typeof closeExecution.useCloseExecution>
  );
}

let checkImpl: () => Promise<void> = async () => {};
let currentRetrySafe: boolean | null = true;
let currentStillUnconfirmed = false;
let currentProgress: CloseProgress | null = null;
let currentSigningPrompt: SigningPrompt | null = null;
function progressAt(wait: CloseProgress["wait"]): CloseProgress {
  return { wait, position: { n: 1, total: 1, atLeast: false }, since: Date.now() };
}
let currentSignatureStatus: {
  requiredWeight: number;
  accumulatedWeight: number;
  contributed: { key: string; weight: number; type: string }[];
  remainingSigners: { key: string; weight: number; type: string }[];
} | null = null;

let currentWalletAddress: string | null = null;
let currentWalletState: Partial<walletKit.WalletKitConnection> = {};
function stubWalletKit(): void {
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: currentWalletAddress,
        connecting: false,
        error: null,
        status: "connected",
        checking: false,
        network: "yes",
        networkConfirmed: false,
        confirmNetwork: () => {},
        verified: true,
        beforeSigning: () => async () => {},
        connect: async () => {},
        disconnect: async () => {},
        ...currentWalletState,
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
}

// The app's real resumable session mechanism is IndexedDB via saveSession
// (apps/web/lib/session/store.ts), not sessionStorage - the only real sessionStorage.setItem
// caller anywhere in apps/web is an unrelated risk-disclaimer modal. Mocking this module (not
// spying on sessionStorage) is what actually lets the "no session-store write between two
// signers" assertion below catch a real regression, since it intercepts every import of the
// module across ExecutionWizard's render tree, not just a direct call from this component.
const mockSaveSession = mock(async (..._args: unknown[]) => {});
function stubSessionStore(): void {
  spyOn(sessionStore, "saveSession").mockImplementation(
    mockSaveSession as unknown as typeof sessionStore.saveSession
  );
  spyOn(sessionStore, "loadSession").mockImplementation(async () => null);
  spyOn(sessionStore, "listSessions").mockImplementation(async () => []);
  spyOn(sessionStore, "deleteSession").mockImplementation(async () => {});
}

const source = Keypair.random().publicKey();
const cosigner = Keypair.random().publicKey();

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  stubRouter();
  stubCloseExecution();
  stubWalletKit();
  stubSessionStore();
  currentSignatureStatus = null;
  currentProgress = null;
  currentSigningPrompt = null;
  currentWalletAddress = null;
  currentWalletState = {};
  submitPreAuthTxImpl = async () => ({ hash: "0".repeat(64), closedAccount: false });
  mockSaveSession.mockClear();
  useDemolishStore.setState({
    executionPlan: [{ id: "s1" } as never],
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    mediatorRequired: false,
    phase: "STEP_EXECUTING",
    lastError: null,
    // Required for the I1 fix: ExecutionWizard only treats a connected wallet as the
    // active signer when its address is a known ed25519 signer on the account, per
    // accountState.signers - not bare equality to sourceAddress. Without this, the
    // second-wallet-switch test below couldn't pass even with the fix correctly applied.
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
});

test("execution-wizard › shows signing progress and remaining signers when weight is short", async () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByText(/1 more signing weight/)).toBeDefined();
  expect(screen.getByText(/Need 1 more of:/).textContent).toContain(
    `${cosigner.slice(0, 8)}…${cosigner.slice(-8)} (weight 1)`
  );
  expect(screen.getByRole("button", { name: /add signature/i })).toBeDefined();
});

test("execution-wizard › connecting a second (co-signer) wallet enables and drives the Add signature CTA", async () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  const setItemSpy = mock((..._args: unknown[]) => {});
  const originalSetItem = window.sessionStorage.setItem.bind(window.sessionStorage);
  window.sessionStorage.setItem = setItemSpy as typeof originalSetItem;

  const runSpy = mock(async (_signer: { publicKey: string }) => {
    // Simulate the second signer clearing the threshold.
    currentSignatureStatus = null;
    useDemolishStore.setState({ phase: "COMPLETE" } as never);
  });
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);

  // Before the co-signer's wallet connects, the CTA has no signer to use yet.
  const addButtonBefore = await screen.findByRole("button", { name: /add signature/i });
  expect((addButtonBefore as HTMLButtonElement).disabled).toBe(true);

  // The co-signer's wallet connects - this is exactly what I1 fixed: previously
  // ExecutionWizard only ever recognized a connected wallet matching sourceAddress, so a
  // correctly-connected co-signer wallet (necessarily a DIFFERENT key from sourceAddress)
  // would never populate the signer and this CTA would stay disabled forever. Re-rendering
  // with the updated mock wallet address is what actually drives that code path, unlike a
  // plain module-level variable assignment with no render in between.
  currentWalletAddress = cosigner;
  rerender(<ExecutionWizard network="testnet" />);

  const addButtonAfter = await screen.findByRole("button", { name: /add signature/i });
  await waitFor(() => expect((addButtonAfter as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(addButtonAfter);

  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(cosigner);

  window.sessionStorage.setItem = originalSetItem;
  expect(setItemSpy).not.toHaveBeenCalled();
  // The real acceptance criterion (issue #100): switching signers within the same round
  // must not write to the app's actual resumable session store (IndexedDB via saveSession).
  // sessionStorage is checked above only as an unrelated second layer of evidence - it isn't
  // the storage layer this criterion is actually about.
  expect(mockSaveSession).not.toHaveBeenCalled();
});

test("execution-wizard › a hash(x) signer among remainingSigners renders its explanation and a preimage input", async () => {
  const preimage = fromHex("deadbeef");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: hashXKey, weight: 1, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByText(/hash\(x\) signer/i)).toBeDefined();
  expect(screen.getByPlaceholderText(/hex-encoded preimage/i)).toBeDefined();
  expect(screen.getByText(/publishes it on the ledger/i)).toBeDefined();
  // Not lumped into the generic "can't yet contribute automatically" line.
  expect(screen.queryByText(/can't yet contribute automatically/i)).toBeNull();
});

test("execution-wizard › a correct hash(x) preimage calls run() with a signer keyed to the hash(x) signer", async () => {
  const preimage = fromHex("deadbeef");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: hashXKey, weight: 1, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  const runSpy = mock(async (_signer: { publicKey: string }) => {
    currentSignatureStatus = null;
    useDemolishStore.setState({ phase: "COMPLETE" } as never);
  });
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);

  const input = screen.getByPlaceholderText(/hex-encoded preimage/i);
  fireEvent.change(input, { target: { value: "deadbeef" } });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));

  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(hashXKey);
});

test("execution-wizard › an incorrect hash(x) preimage shows an inline error and never calls run()", async () => {
  const hashXKey = StrKey.encodeSha256Hash(hash(fromHex("deadbeef")));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: hashXKey, weight: 1, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);

  const input = screen.getByPlaceholderText(/hex-encoded preimage/i);
  fireEvent.change(input, { target: { value: "cafebabe" } }); // does not hash to hashXKey
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));

  expect(await screen.findByText(/does not hash to the signer's key/i)).toBeDefined();
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › normal (non-multisig) failure still shows the retry branch, not signing progress", async () => {
  currentSignatureStatus = null;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "The close failed." } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByRole("button", { name: /retry/i })).toBeDefined();
  expect(screen.queryByText(/more signing weight/)).toBeNull();
  expect(screen.queryByRole("button", { name: /add signature/i })).toBeNull();
});

test("execution-wizard › the failed state says under Retry that retrying is safe", async () => {
  currentSignatureStatus = null;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "The close failed." } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  const retry = await screen.findByRole("button", { name: /retry/i });
  const note = screen.getByText(
    "Safe to retry. LumenWipe re-reads your account first, so a confirmed transaction is never sent twice."
  );
  expectSameElement(retry.nextElementSibling, note);
});

test("execution-wizard › a failure whose retry safety is unknown makes no safe-to-retry claim", async () => {
  currentRetrySafe = null;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "The close failed." } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  await screen.findByRole("button", { name: /retry/i });
  expect(screen.queryByText(/Safe to retry/)).toBeNull();
  currentRetrySafe = true;
});

test("execution-wizard › progress that could not be saved shows a notice beside the signing", async () => {
  useDemolishStore.setState({ progressNotSaved: true });
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(screen.getByText(PROGRESS_NOT_SAVED)).toBeDefined();
  expect(screen.getByRole("tablist")).toBeDefined();
  useDemolishStore.setState({ progressNotSaved: false });
});

test("execution-wizard › a run this mount did not start shows as busy, with no way to start another", async () => {
  useDemolishStore.setState({ signingRun: true });
  runImpl = async () => {};
  try {
    render(<ExecutionWizard network="testnet" />);

    expect(screen.getAllByText("Working…").length).toBeGreaterThan(0);
    expect(screen.queryByRole("tablist")).toBeNull();
  } finally {
    useDemolishStore.setState({ signingRun: false });
  }
});

// #102: pre-auth-tx signer support.
test("execution-wizard › a retry that is not safe drops the note under Retry", async () => {
  currentRetrySafe = false;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "It carried a preimage." } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  await screen.findByRole("button", { name: /retry/i });
  expect(screen.queryByText(/Safe to retry/)).toBeNull();
  currentRetrySafe = true;
});

test("execution-wizard › an unknown outcome shows the hash and a check, never failed or a retry", async () => {
  const hash = "a".repeat(64);
  const check = mock(async () => {});
  checkImpl = check;
  useDemolishStore.setState({
    phase: "STEP_UNCONFIRMED",
    lastError: null,
    unconfirmedSubmission: { hash, covers: ["MERGE"], validUntil: null },
  });
  render(<ExecutionWizard network="testnet" />);

  expect(screen.getByTestId("unconfirmed-panel").textContent).toContain(hash);
  expect(document.body.textContent).toContain(UNCONFIRMED_NOTICE);
  expect(document.body.textContent).not.toMatch(/failed|safe to retry/i);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(check).toHaveBeenCalledTimes(1);
  useDemolishStore.setState({ unconfirmedSubmission: null, phase: "STEP_EXECUTING" });
});

test("execution-wizard › a preauth_tx signer among remainingSigners renders its explanation, an XDR textarea, and the persistent warning", async () => {
  const preAuthKey = "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJRY"; // any-shaped preauth key for display purposes
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: preAuthKey, weight: 1, type: "preauth_tx" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByText(/pre-auth-tx signer/i)).toBeDefined();
  expect(screen.getByPlaceholderText(/paste the pre-authorized transaction xdr/i)).toBeDefined();
  // The persistent, non-dismissible warning the issue requires wherever this path is active.
  expect(screen.getByText(/not built or verified by lumenwipe the way the rest/i)).toBeDefined();
  // Not lumped into the generic "can't yet contribute automatically" line.
  expect(screen.queryByText(/can't yet contribute automatically/i)).toBeNull();
});

const PRE_AUTH_KEY = "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJRY";
const PRE_AUTH_HASH = "ab".repeat(32);

/** A pre-authorized transaction of several operations, one of a type the close vocabulary does
 *  not describe (bump sequence), ending in a merge, with a text memo. */
function preAuthXdr(mergeTo: string): string {
  return (
    new TransactionBuilder(new Account(source, "41"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(0)
      .addMemo(Memo.text("prepaid"))
      // Acting as another account than the transaction's source, which the list must say.
      .addOperation(
        Operation.payment({
          destination: mergeTo,
          asset: Asset.native(),
          amount: "1",
          source: mergeTo,
        })
      )
      .addOperation(Operation.bumpSequence({ bumpTo: "100" }))
      .addOperation(Operation.accountMerge({ destination: mergeTo }))
      .build()
      .toXdr()
  );
}

function pausedOnPreAuthSigner(): void {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: PRE_AUTH_KEY, weight: 1, type: "preauth_tx" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
}

function pasteAndReview(xdr: string): void {
  fireEvent.change(screen.getByPlaceholderText(/paste the pre-authorized transaction xdr/i), {
    target: { value: xdr },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review transaction" }));
}

test("execution-wizard › a pasted pre-authorized transaction is listed in full, and only a second click submits it", async () => {
  pausedOnPreAuthSigner();
  runImpl = async () => {};
  const submitSpy = mock(async () => ({ hash: PRE_AUTH_HASH, closedAccount: false }));
  submitPreAuthTxImpl = submitSpy;
  const mergeTo = Keypair.random().publicKey();
  const xdr = preAuthXdr(mergeTo);

  render(<ExecutionWizard network="testnet" />);
  expect(
    screen.queryAllByRole("button", { name: /submit pre-authorized transaction/i })
  ).toHaveLength(0);
  pasteAndReview(xdr);

  const summary = screen.getByRole("region", { name: "What this transaction does" });
  expect(summary.textContent).toContain(`Source account: ${source}`);
  const operations = screen
    .getAllByRole("listitem")
    .filter((li) => screen.getByRole("list", { name: "Operations" }).contains(li));
  expect(operations.map((li) => li.textContent)).toEqual([
    `Pay 1.0000000 XLM to ${mergeTo} (acting as ${mergeTo})`,
    "Unrecognized operation (bumpSequence)",
    `Merge account ${source} into ${mergeTo}`,
  ]);
  expect(summary.textContent).toContain(`Merge destination: ${mergeTo}`);
  expect(summary.textContent).toContain("Memo: text: prepaid (7 bytes)");
  expect(summary.textContent).toContain("Fee: 0.0000300 XLM");
  expect(summary.textContent).toContain("Sequence number: 42");
  expect(summary.textContent).toContain("Valid: no time limit");
  // Reviewing sends nothing.
  expect(submitSpy).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));
  await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
  expect(submitSpy.mock.calls[0]).toEqual([
    { key: PRE_AUTH_KEY, weight: 1, type: "preauth_tx" },
    xdr,
  ] as never);
});

test("execution-wizard › an unreadable pasted transaction is not offered for submission", () => {
  pausedOnPreAuthSigner();
  runImpl = async () => {};
  const submitSpy = mock(async () => ({ hash: PRE_AUTH_HASH, closedAccount: false }));
  submitPreAuthTxImpl = submitSpy;

  render(<ExecutionWizard network="testnet" />);
  pasteAndReview("AAAAAgAAAAA=");

  expect(screen.getByText(/This transaction could not be read/)).toBeDefined();
  expect(
    screen.queryAllByRole("button", { name: /submit pre-authorized transaction/i })
  ).toHaveLength(0);
  expect(submitSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a rejected pre-auth-tx submission shows an inline error", async () => {
  pausedOnPreAuthSigner();
  runImpl = async () => {};
  submitPreAuthTxImpl = async () => {
    throw new InvalidPreAuthTxError(
      "This transaction's hash does not match the pre-auth-tx signer's key."
    );
  };

  render(<ExecutionWizard network="testnet" />);
  pasteAndReview(preAuthXdr(Keypair.random().publicKey()));
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  expect(await screen.findByText(/does not match the pre-auth-tx signer's key/i)).toBeDefined();
  expect(screen.queryAllByText(/Pre-authorized transaction confirmed/)).toHaveLength(0);
});

test("execution-wizard › a confirmed pre-authorized transaction shows its hash and continues the close with no signer", async () => {
  pausedOnPreAuthSigner();
  const runSpy = mock(async (_signer: { publicKey: string } | null) => {});
  runImpl = runSpy;
  submitPreAuthTxImpl = async () => ({ hash: PRE_AUTH_HASH, closedAccount: false });

  render(<ExecutionWizard network="testnet" />);
  pasteAndReview(preAuthXdr(Keypair.random().publicKey()));
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]).toBeNull();
  const link = screen.getByRole("link", { name: /View it on Stellar Expert/ });
  expect(link.getAttribute("href")).toBe(
    `https://stellar.expert/explorer/testnet/tx/${PRE_AUTH_HASH}`
  );
  expect(screen.getByText(PRE_AUTH_HASH)).toBeDefined();
});

test("execution-wizard › a pre-authorized merge completes the close without a run", async () => {
  pausedOnPreAuthSigner();
  const runSpy = mock(async (_signer: { publicKey: string } | null) => {});
  runImpl = runSpy;
  submitPreAuthTxImpl = async () => ({ hash: PRE_AUTH_HASH, closedAccount: true });

  render(<ExecutionWizard network="testnet" />);
  pasteAndReview(preAuthXdr(Keypair.random().publicKey()));
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  await waitFor(() => expect(screen.getByText(PRE_AUTH_HASH)).toBeDefined());
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a failed continuation shows the failure and Retry continues again without resubmitting", async () => {
  pausedOnPreAuthSigner();
  const submitSpy = mock(async () => ({ hash: PRE_AUTH_HASH, closedAccount: false }));
  submitPreAuthTxImpl = submitSpy;
  const failure = closeFailureMessage(new Error("boom"), "before-submit", []);
  const runSpy = mock(async (_signer: { publicKey: string } | null) => {
    // The continuation fails: no pause, a plain failure.
    currentSignatureStatus = null;
    useDemolishStore.setState({ phase: "STEP_FAILED", lastError: failure } as never);
  });
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  pasteAndReview(preAuthXdr(Keypair.random().publicKey()));
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  rerender(<ExecutionWizard network="testnet" />);

  expect(screen.getByText(failure)).toBeDefined();
  const retry = (await screen.findByRole("button", { name: "Retry" })) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(2));
  expect(runSpy.mock.calls[1]?.[0]).toBeNull();
  expect(submitSpy).toHaveBeenCalledTimes(1);
});

// ─── The multisig nature must be visible BEFORE the first signature ──────────
//
// The signing-progress panel appears only after a signature falls short, so a user who did
// not know their account was multisig discovered it by failing: sign once, then learn that
// more weight is needed. The notice states the requirement - how much weight, which signers
// can contribute - up front, on the same screen that asks for the first signature.

test("execution-wizard › announces the signer set and required weight before any signature", () => {
  currentSignatureStatus = null; // nothing signed yet
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  const notice = screen.getByTestId("multisig-notice");
  expect(notice.textContent).toContain("2"); // the required weight
  // Both eligible signers are listed by their shortened keys.
  expect(notice.textContent).toContain(source.slice(0, 8));
  expect(notice.textContent).toContain(cosigner.slice(0, 8));
});

test("execution-wizard › a single-signer account gets no multisig notice", () => {
  currentSignatureStatus = null;
  runImpl = async () => {};
  useDemolishStore.setState({
    accountState: {
      signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 1, high: 1 },
    } as never,
  } as never);

  render(<ExecutionWizard network="testnet" />);

  expect(screen.queryByTestId("multisig-notice")).toBeNull();
});

test("execution-wizard › the notice does not repeat once signing progress is on screen", () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  // The progress panel already says what remains; a second banner restating the
  // requirement would be noise.
  expect(screen.queryByTestId("multisig-notice")).toBeNull();
});

// Announcements and focus on view swaps (#357).
function swapView(
  rerender: (ui: React.ReactElement) => void,
  next: { progress: CloseProgress | null; phase: string }
): void {
  currentProgress = next.progress;
  act(() => {
    useDemolishStore.setState({ phase: next.phase } as never);
    rerender(<ExecutionWizard network="testnet" />);
  });
}

test("execution-wizard › announces progress through one status region and hides the spinner", () => {
  currentProgress = progressAt("wallet");
  const { container } = render(<ExecutionWizard network="testnet" />);

  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0].textContent).toBe(WAITING_LINE);
  expect(
    container.querySelector("svg.motion-safe\\:animate-spin")?.getAttribute("aria-hidden")
  ).toBe("true");

  const exposed = Array.from(screen.getAllByText(WAITING_LINE)).filter(
    (el) => !el.closest("[aria-hidden='true']")
  );
  expect(exposed).toEqual([statuses[0]]);
});

test("execution-wizard › announces that more signatures are needed", () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  render(<ExecutionWizard network="testnet" />);

  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0].textContent).toBe("More signatures needed. 1 of 2 signing weight collected.");
});

test("execution-wizard › does not move focus on first render of the setup view", () => {
  render(<ExecutionWizard network="testnet" />);
  expectFocusedNow(document.body);
});

test("execution-wizard › focus moves to the heading when signing starts and to Retry after a failure", async () => {
  currentWalletAddress = source;
  useDemolishStore.setState({ lastError: "The close failed." } as never);
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  const heading = screen.getByRole("heading", { name: /sign & execute the close/i });

  swapView(rerender, { progress: progressAt("network"), phase: "STEP_EXECUTING" });
  await expectFocused(heading);

  swapView(rerender, { progress: null, phase: "STEP_FAILED" });
  const retry = await screen.findByRole("button", { name: /retry/i });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  await expectFocused(retry);
  expect(screen.getByRole("alert").textContent).toContain("The close failed.");
});

test("execution-wizard › a failure with no usable signer focuses the alert instead of a disabled Retry", async () => {
  useDemolishStore.setState({ lastError: "The close failed." } as never);
  const { rerender } = render(<ExecutionWizard network="testnet" />);

  swapView(rerender, { progress: progressAt("network"), phase: "STEP_EXECUTING" });
  swapView(rerender, { progress: null, phase: "STEP_FAILED" });

  expect(
    (await screen.findByRole("button", { name: /retry/i })) as HTMLButtonElement
  ).toHaveProperty("disabled", true);
  await expectFocused(screen.getByRole("alert"));
});

test("execution-wizard › a view swap never steals focus from a field being typed in", () => {
  const field = document.createElement("input");
  document.body.appendChild(field);
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  act(() => field.focus());

  swapView(rerender, { progress: progressAt("network"), phase: "STEP_EXECUTING" });
  expectFocusedNow(field);
  field.remove();
});

test("execution-wizard › the signer picker is a tablist that arrow keys switch", () => {
  render(<ExecutionWizard network="testnet" />);
  screen.getByRole("tablist", { name: "How to sign" });
  const wallet = screen.getByRole("tab", { name: "Connect wallet" });
  expect(wallet.getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByPlaceholderText("S...")).toBeNull();

  fireEvent.keyDown(wallet, { key: "ArrowRight" });
  const secret = screen.getByRole("tab", { name: "Use secret key (advanced)" });
  expect(secret.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByPlaceholderText("S...")).toBeDefined();

  fireEvent.keyDown(secret, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Connect wallet" }).getAttribute("aria-selected")).toBe(
    "true"
  );
  expect(screen.queryByPlaceholderText("S...")).toBeNull();
});

test("execution-wizard › the signer tabs are not rendered while the close is running", () => {
  currentProgress = progressAt("network");
  render(<ExecutionWizard network="testnet" />);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
});

function wizardStep(index: number, title: string, status: string, txHash: string | null = null) {
  return {
    index,
    type: "MERGE",
    title,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash,
    error: null,
  };
}

test("execution-wizard › the highlighted step is the first unconfirmed one, in both step lists", () => {
  useDemolishStore.setState({
    executionPlan: [
      wizardStep(0, "Remove signers", "confirmed", "a".repeat(64)),
      wizardStep(1, "Close offers", "failed"),
      wizardStep(2, "Merge account", "pending"),
    ],
  } as never);
  const { container } = render(<ExecutionWizard network="testnet" />);

  const lists = screen.getAllByRole("list", { name: "Plan steps" });
  expect(lists).toHaveLength(2);
  for (const list of lists) {
    const current = list.querySelectorAll("[aria-current='step']");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Close offers");
    expect(current[0].textContent).toContain("Failed");
    expect(list.textContent).toContain("Confirmed");
    expect(list.textContent).toContain("Waiting");
  }
  expect(container.querySelectorAll("[aria-current='step']")).toHaveLength(2);
});

test("execution-wizard › a step in flight spins only while the close runs, and reads as sent once it stops", () => {
  useDemolishStore.setState({
    executionPlan: [wizardStep(0, "Merge account", "submitted")],
    signingRun: true,
  } as never);
  currentProgress = progressAt("network");
  const { container, rerender } = render(<ExecutionWizard network="testnet" />);
  const row = () => container.querySelector("li[aria-current='step']")!;
  expect(row().textContent).toContain("Confirming");
  const spinner = row().querySelector("svg.motion-safe\\:animate-spin");
  expect(spinner?.closest("[aria-hidden='true']")).not.toBeNull();

  currentProgress = null;
  act(() => {
    useDemolishStore.setState({ signingRun: false, phase: "STEP_UNCONFIRMED" } as never);
    rerender(<ExecutionWizard network="testnet" />);
  });
  expect(row().textContent).toContain("Sent, not confirmed");
  expect(row().querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
});

test("execution-wizard › a wait past 20 seconds says to keep the tab open, once, through the status region", () => {
  currentProgress = { ...progressAt("wallet"), since: Date.now() - 25_000 };
  render(<ExecutionWizard network="testnet" />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe(
    "Transaction 1 of 1: approve in your wallet Still waiting. Do not close this tab."
  );
  expect(status.textContent).not.toMatch(/\d:\d\d/);
});

test("execution-wizard › a failure in a later round leaves the earlier confirmed hash and its explorer link on screen", () => {
  const hash = `abcdef${"0".repeat(52)}123456`;
  useDemolishStore.setState({
    executionPlan: [
      wizardStep(0, "Remove signers", "confirmed", hash),
      wizardStep(1, "Merge account", "failed"),
    ],
    phase: "STEP_FAILED",
    lastError: "You declined the request in your wallet.",
  } as never);
  render(<ExecutionWizard network="mainnet" />);

  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  const links = screen.getAllByRole("link", {
    name: "View transaction abcdef…123456 on Stellar Expert (opens in a new tab)",
  });
  // The desktop sidebar and the mobile step list both carry it.
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link.getAttribute("href")).toBe(`https://stellar.expert/explorer/public/tx/${hash}`);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  }
  expect(
    screen.getAllByRole("button", { name: "Copy transaction hash abcdef…123456" })
  ).toHaveLength(2);
  // Only the confirmed step has one.
  expect(screen.getAllByRole("link", { name: /View transaction/ })).toHaveLength(2);
});

test("execution-wizard › copying a confirmed hash says so on screen", async () => {
  const hash = `abcdef${"0".repeat(52)}123456`;
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  useDemolishStore.setState({
    executionPlan: [wizardStep(0, "Remove signers", "confirmed", hash)],
  } as never);
  render(<ExecutionWizard network="testnet" />);

  const [copy] = screen.getAllByRole("button", { name: "Copy transaction hash abcdef…123456" });
  await act(async () => {
    fireEvent.click(copy);
  });
  expect(writeText).toHaveBeenCalledWith(hash);
  expect(copy.parentElement?.textContent).toContain("Copied");
});

test("execution-wizard › the destination links to the explorer of the network being closed on", () => {
  render(<ExecutionWizard network="testnet" />);
  const destination = useDemolishStore.getState().destinationAddress!;
  const link = screen.getByRole("link", { name: /View the destination on Stellar Expert/ });
  expect(link.getAttribute("href")).toBe(
    `https://stellar.expert/explorer/testnet/account/${destination}`
  );
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("execution-wizard › a wallet that timed out offers Retry and changing the signer, and is no longer busy", () => {
  currentWalletAddress = source;
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    lastError: closeFailureMessage(
      new WalletSigningTimeoutError("freighter", 120_000),
      "before-submit",
      []
    ),
  } as never);
  render(<ExecutionWizard network="testnet" />);
  expect(screen.getByText(/Your wallet didn't respond in time/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Change wallet or key" })).toBeDefined();
  expect(screen.queryByText(/In progress/)).toBeNull();
});

test("execution-wizard › a WalletConnect prompt shows how long it has waited from the start", () => {
  currentProgress = { ...progressAt("wallet-app"), since: Date.now() - 5_000 };
  const { container } = render(<ExecutionWizard network="testnet" />);
  expect(container.textContent).toContain("Transaction 1 of 1: approve in your wallet app");
  expect(container.textContent).toContain("0:05");
  expect(screen.getByRole("status").textContent).not.toContain("0:05");
});

function timedOutWallet(stale: Promise<void> | null): void {
  const signer = Object.assign(Object.create(WalletKitSigner.prototype) as WalletKitSigner, {
    publicKey: source,
    stalePrompt: () => stale,
  });
  spyOn(walletKitClient, "walletKitSigner").mockImplementation(() => signer);
  currentWalletAddress = source;
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    lastError: closeFailureMessage(
      new WalletSigningTimeoutError(null, 120_000),
      "before-submit",
      []
    ),
  } as never);
}

test("execution-wizard › after a timeout, Retry waits for the earlier wallet prompt to answer", async () => {
  let answer!: () => void;
  timedOutWallet(new Promise<void>((resolve) => (answer = resolve)));
  render(<ExecutionWizard network="testnet" />);
  const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(screen.getByText(/Close the earlier prompt in your wallet/)).toBeDefined();
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  expect(retry.disabled).toBe(false);
});

test("execution-wizard › after a timeout, Retry is offered again after 5 s if the prompt never answers", async () => {
  const real = globalThis.setTimeout;
  let hold: (() => void) | null = null;
  spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === STALE_PROMPT_HOLD_MS) {
      hold = fn;
      return 0;
    }
    return real(fn, ms);
  }) as unknown as typeof setTimeout);
  timedOutWallet(new Promise<void>(() => {}));
  render(<ExecutionWizard network="testnet" />);
  const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(hold).not.toBeNull();
  act(() => hold!());
  expect(retry.disabled).toBe(false);
});

test("execution-wizard › Retry is not held when no wallet prompt is left open", () => {
  timedOutWallet(null);
  render(<ExecutionWizard network="testnet" />);
  expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
});

// #400: the signer on screen is the signer that signs, and a signer that already signed is not
// asked again.
const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
/** The signer line's text, or null without one. Asserted as text, never as an element: a failing
 *  match on a DOM element makes the matcher print the whole element, which never finishes. */
const activeSignerText = (): string | null =>
  screen.queryByTestId("active-signer")?.textContent ?? null;

test("execution-wizard › after a hash(x) round, the next Add signature uses the wallet on screen, not the preimage", async () => {
  const hashXKey = StrKey.encodeSha256Hash(hash(fromHex("deadbeef")));
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    accountState: {
      signers: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
        { key: hashXKey, weight: 1, type: "hash_x" },
      ],
      thresholds: { low: 1, med: 3, high: 3 },
    } as never,
  } as never);
  currentWalletAddress = cosigner;
  currentSignatureStatus = {
    requiredWeight: 3,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [
      { key: hashXKey, weight: 1, type: "hash_x" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
  };
  let finishHashXRound: () => void = () => {};
  const runSpy = mock(
    (_signer: { publicKey: string }) =>
      new Promise<void>((resolve) => {
        finishHashXRound = resolve;
      })
  );
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(cosigner))
  );

  fireEvent.change(screen.getByPlaceholderText(/hex-encoded preimage/i), {
    target: { value: "deadbeef" },
  });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(hashXKey);
  // While the preimage signs, the screen names the preimage, not the connected wallet.
  const during = screen.getByTestId("active-signer").textContent ?? "";
  expect(during).toContain("hash(x)");
  expect(during).toContain(short(hashXKey));
  expect(during).not.toContain(short(cosigner));

  // The round pauses again, still one signature short.
  currentSignatureStatus = {
    requiredWeight: 3,
    accumulatedWeight: 2,
    contributed: [
      { key: source, weight: 1, type: "ed25519_public_key" },
      { key: hashXKey, weight: 1, type: "hash_x" },
    ],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  runImpl = mock(async (_signer: { publicKey: string }) => {});
  await act(async () => {
    finishHashXRound();
  });
  rerender(<ExecutionWizard network="testnet" />);

  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(cosigner))
  );
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
  await waitFor(() => expect(runImpl).toHaveBeenCalledTimes(1));
  expect((runImpl as ReturnType<typeof mock>).mock.calls[0]?.[0]?.publicKey).toBe(cosigner);
});

test("execution-wizard › a wallet that already signed cannot start another prompt, and says why", async () => {
  currentWalletAddress = source;
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);

  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(source))
  );
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  expect(screen.getByText(ALREADY_SIGNED)).toBeDefined();
  fireEvent.click(add);
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a secret key that already signed cannot sign again, and a remaining one can", async () => {
  const sourceKey = Keypair.random();
  const cosignerKey = Keypair.random();
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    accountState: {
      signers: [
        { key: sourceKey.publicKey(), weight: 1, type: "ed25519_public_key" },
        { key: cosignerKey.publicKey(), weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: sourceKey.publicKey(), weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: cosignerKey.publicKey(), weight: 1, type: "ed25519_public_key" }],
  };
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  fireEvent.click(screen.getByRole("tab", { name: "Use secret key (advanced)" }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: sourceKey.secret() },
  });

  const add = (await screen.findByRole("button", {
    name: /add signature/i,
  })) as HTMLButtonElement;
  await waitFor(() => expect(screen.getByText(ALREADY_SIGNED)).toBeDefined());
  expect(add.disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: /forget key/i }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: cosignerKey.secret() },
  });
  await waitFor(() => expect(add.disabled).toBe(false));
  expect(screen.queryByText(ALREADY_SIGNED)?.textContent ?? null).toBeNull();
  fireEvent.click(add);
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(cosignerKey.publicKey());
});

test("execution-wizard › a hash(x) preimage is not offered again once its round has counted it", async () => {
  const hashXKey = StrKey.encodeSha256Hash(hash(fromHex("deadbeef")));
  currentSignatureStatus = {
    requiredWeight: 3,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [
      { key: hashXKey, weight: 1, type: "hash_x" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {
    currentSignatureStatus = {
      requiredWeight: 3,
      accumulatedWeight: 2,
      contributed: [
        { key: source, weight: 1, type: "ed25519_public_key" },
        { key: hashXKey, weight: 1, type: "hash_x" },
      ],
      remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
    };
  });
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  fireEvent.change(screen.getByPlaceholderText(/hex-encoded preimage/i), {
    target: { value: "deadbeef" },
  });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  rerender(<ExecutionWizard network="testnet" />);

  const add = (await screen.findByRole("button", {
    name: /add signature/i,
  })) as HTMLButtonElement;
  await waitFor(() => expect(activeSignerText()).toBeNull());
  expect(add.disabled).toBe(true);
  fireEvent.click(add);
  expect(runSpy).toHaveBeenCalledTimes(1);
});

test("execution-wizard › the signed list and the still-needed line show each signer's weight", () => {
  const third = Keypair.random().publicKey();
  currentSignatureStatus = {
    requiredWeight: 4,
    accumulatedWeight: 2,
    contributed: [{ key: source, weight: 2, type: "ed25519_public_key" }],
    remainingSigners: [
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
      { key: third, weight: 1, type: "ed25519_public_key" },
    ],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  const signed = screen.getByRole("list", { name: "Signed" });
  expect(signed.textContent).toContain(`${source.slice(0, 8)}…${source.slice(-8)}`);
  expect(signed.textContent).toContain("signed, weight 2");
  const needed = screen.getByText(/Need 2 more of:/).textContent ?? "";
  expect(needed).toContain(`${cosigner.slice(0, 8)}…${cosigner.slice(-8)} (weight 1)`);
  expect(needed).toContain(`${third.slice(0, 8)}…${third.slice(-8)} (weight 1)`);

  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("2");
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("4");
  expect(bar.getAttribute("aria-valuetext")).toBe("2 of 4 signature weight collected");
});

test("execution-wizard › the multisig notice says each transaction needs the full weight", () => {
  useDemolishStore.setState({ estimatedTransactionCount: 3 } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(screen.getByTestId("multisig-notice").textContent).toContain(
    "Each transaction needs that full weight on its own, so expect to sign up to 3 times with each signer."
  );
  useDemolishStore.setState({ estimatedTransactionCount: null } as never);
});

// #402: the wallet is only used once its session is checked, and a check still running holds it.
test("execution-wizard › a wallet session that is not checked never becomes the signer", () => {
  currentWalletAddress = source;
  currentWalletState = { status: "stale", verified: false };
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(activeSignerText()).toBeNull();
  expect(screen.getByRole("button", { name: "Reconnect wallet" })).toBeDefined();
  expect(screen.queryByText(/Connected:/)?.textContent ?? null).toBeNull();
});

test("execution-wizard › a wallet whose network is unknown signs only after the user confirms it", () => {
  currentWalletAddress = source;
  currentWalletState = { network: "unknown", verified: false };
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(activeSignerText()).toBeNull();
  expect(
    screen.getByRole("checkbox", {
      name: "Your wallet does not report which network it is on. I checked that it is set to TESTNET.",
    })
  ).toBeDefined();
});

test("execution-wizard › a wallet check still running holds the sign button", async () => {
  currentWalletAddress = source;
  currentWalletState = { checking: true };
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(source))
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  const sign = screen.getByRole("button", { name: /Sign & execute close/ }) as HTMLButtonElement;
  expect(sign.disabled).toBe(true);
  fireEvent.click(sign);
  expect(runSpy).not.toHaveBeenCalled();

  currentWalletState = { checking: false };
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(sign.disabled).toBe(false));
  fireEvent.click(sign);
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
});

test("execution-wizard › a wallet that signed with another account offers a one-click switch and the keys that can sign", async () => {
  const wrong = Keypair.random();
  const signer = new WalletKitSigner(source, async () => ({
    signedTxXdr: "unused",
    signerAddress: wrong.publicKey(),
  }));
  await signer.sign(mergeTxXdr(), Networks.TESTNET).catch(() => {});
  expect(signer.mismatchedAccount()).toBe(wrong.publicKey());
  spyOn(walletKitClient, "walletKitSigner").mockImplementation(() => signer);
  currentWalletAddress = source;
  const disconnect = mock(async () => {});
  const connect = mock(async () => {});
  currentWalletState = { disconnect, connect };
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    lastError: walletAccountMismatch(wrong.publicKey(), source),
  } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(screen.getByText(/Your wallet signed with a different account/).textContent).toContain(
    `${wrong.publicKey().slice(0, 4)}…${wrong.publicKey().slice(-4)}`
  );
  const keys = screen.getByRole("list", { name: "Keys that can sign" });
  expect(keys.textContent).toContain(short(source));
  expect(keys.textContent).toContain(short(cosigner));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect and choose another wallet" }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test("execution-wizard › a connected wallet that is not a signer lists the keys that can sign", () => {
  currentWalletAddress = Keypair.random().publicKey();
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  const keys = screen.getByRole("list", { name: "Keys that can sign" });
  expect(keys.textContent).toContain(short(source));
  expect(
    screen.getByRole("button", { name: "Disconnect and choose another wallet" })
  ).toBeDefined();
});

function mergeTxXdr(): string {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(300)
    .addOperation(Operation.accountMerge({ destination: cosigner }))
    .build()
    .toXdr();
}

test("execution-wizard › a secret key the user entered is not replaced by a connected wallet", async () => {
  const sourceKey = Keypair.random();
  useDemolishStore.setState({
    accountState: {
      signers: [
        { key: sourceKey.publicKey(), weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    } as never,
  } as never);
  currentWalletAddress = cosigner;
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(cosigner))
  );
  fireEvent.click(screen.getByRole("tab", { name: "Use secret key (advanced)" }));
  fireEvent.change(screen.getByPlaceholderText("S..."), {
    target: { value: sourceKey.secret() },
  });
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(sourceKey.publicKey()))
  );
  // The wallet is still connected and usable in the background.
  rerender(<ExecutionWizard network="testnet" />);
  expect(screen.getByTestId("active-signer").textContent).toContain(short(sourceKey.publicKey()));

  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Sign & execute close/ }));
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(sourceKey.publicKey());
});

test("execution-wizard › after a pause on the secret-key tab, the wallet is not picked up until the user goes back to it", async () => {
  currentWalletAddress = cosigner;
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(cosigner))
  );
  fireEvent.click(screen.getByRole("tab", { name: "Use secret key (advanced)" }));

  // The round pauses again while the user is on the secret-key tab.
  currentSignatureStatus = { ...currentSignatureStatus, accumulatedWeight: 1 };
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(activeSignerText()).toBeNull());
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);

  fireEvent.click(screen.getByRole("tab", { name: "Connect wallet" }));
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(cosigner))
  );
});

test("execution-wizard › a wallet run is checked again before each signature, by the wallet and for its signer", async () => {
  currentWalletAddress = source;
  const guard = mock(async () => {});
  const beforeSigning = mock((_address: string) => guard);
  currentWalletState = { beforeSigning };
  const runSpy = mock(async (_signer: { publicKey: string }, _options?: RunOptions) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  await waitFor(() =>
    expect(screen.getByTestId("active-signer").textContent).toContain(short(source))
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Sign & execute close/ }));
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(beforeSigning).toHaveBeenCalledWith(source);
  await runSpy.mock.calls[0]?.[1]?.beforeSign?.();
  expect(guard).toHaveBeenCalledTimes(1);
});

test("execution-wizard › after a wallet left the network mid-run, Retry comes back once it is usable again", async () => {
  currentWalletAddress = source;
  currentWalletState = { network: "no", verified: false };
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    lastError: closeFailureMessage(
      new WalletNotUsableError("network", "testnet"),
      "before-submit",
      []
    ),
  } as never);
  runImpl = async () => {};

  const { rerender } = render(<ExecutionWizard network="testnet" />);
  expect(
    screen.getByText(/Your wallet is now on a different network than this page/)
  ).toBeDefined();
  const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);

  // Switched back (or reconnected): checked and on the page's network again.
  currentWalletState = {};
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(retry.disabled).toBe(false));
});

test("execution-wizard › a session check that briefly fails during a stale prompt keeps Retry held", async () => {
  let answer!: () => void;
  timedOutWallet(new Promise<void>((resolve) => (answer = resolve)));
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  const retry = () => screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry().disabled).toBe(true);

  // The session check fails for a moment, then passes: the signer is dropped and picked up again.
  currentWalletState = { verified: false };
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(activeSignerText()).toBeNull());
  currentWalletState = {};
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(screen.getByTestId("active-signer")).toBeDefined());
  expect(retry().disabled).toBe(true);

  await act(async () => {
    answer();
    await Promise.resolve();
  });
  expect(retry().disabled).toBe(false);
});

function memoXdr(memo: Memo): string {
  return new TransactionBuilder(new Account(source, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(0)
    .addMemo(memo)
    .addOperation(Operation.accountMerge({ destination: cosigner }))
    .build()
    .toXdr();
}

test("execution-wizard › an id memo and a text memo of the same digits read differently", () => {
  pausedOnPreAuthSigner();
  runImpl = async () => {};

  const { unmount } = render(<ExecutionWizard network="testnet" />);
  pasteAndReview(memoXdr(Memo.id("123")));
  const idMemo = screen.getByRole("region", { name: "What this transaction does" }).textContent;
  unmount();

  render(<ExecutionWizard network="testnet" />);
  pasteAndReview(memoXdr(Memo.text("123")));
  const textMemo = screen.getByRole("region", { name: "What this transaction does" }).textContent;

  expect(idMemo).toContain("Memo: id: 123");
  expect(textMemo).toContain("Memo: text: 123 (3 bytes)");
  expect(idMemo).not.toBe(textMemo);
});

test("execution-wizard › while a pre-authorized transaction is being sent, no other signature can start", async () => {
  pausedOnPreAuthSigner();
  currentWalletAddress = cosigner;
  currentSignatureStatus = {
    ...currentSignatureStatus!,
    remainingSigners: [
      { key: PRE_AUTH_KEY, weight: 1, type: "preauth_tx" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
  };
  const runSpy = mock(async (_signer: { publicKey: string } | null) => {});
  runImpl = runSpy;
  let answer: (value: PreAuthSubmission) => void = () => {};
  submitPreAuthTxImpl = () =>
    new Promise<PreAuthSubmission>((resolve) => {
      answer = resolve;
    });

  render(<ExecutionWizard network="testnet" />);
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  pasteAndReview(preAuthXdr(Keypair.random().publicKey()));
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  await waitFor(() => expect(add.disabled).toBe(true));
  for (const tab of screen.getAllByRole("tab")) {
    expect((tab as HTMLButtonElement).disabled).toBe(true);
  }
  fireEvent.click(add);
  expect(runSpy).not.toHaveBeenCalled();

  await act(async () => {
    answer({ hash: PRE_AUTH_HASH, closedAccount: false });
    await Promise.resolve();
  });
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]).toBeNull();
});

test("execution-wizard › a pre-authorized transaction left unconfirmed holds signing until it settles", () => {
  currentWalletAddress = cosigner;
  pausedOnPreAuthSigner();
  useDemolishStore.setState({
    phase: "STEP_UNCONFIRMED",
    unconfirmedSubmission: { hash: PRE_AUTH_HASH, covers: ["MERGE"], validUntil: null },
  } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(screen.queryAllByRole("button", { name: /add signature/i })).toHaveLength(0);
  expect(screen.getByRole("button", { name: /check again/i })).toBeDefined();
  useDemolishStore.setState({ unconfirmedSubmission: null } as never);
});

// The signer object is held outside React state. These watch the real hook through a pass-through
// spy, to read what it holds after each way the screen drops a signer.
const realUseActiveSigner = activeSignerHook.useActiveSigner;
let signerControl: activeSignerHook.ActiveSignerControl | null = null;
function watchHeldSigner(): () => ReturnType<activeSignerHook.ActiveSignerControl["current"]> {
  signerControl = null;
  spyOn(activeSignerHook, "useActiveSigner").mockImplementation(() => {
    const control = realUseActiveSigner();
    signerControl = control;
    return control;
  });
  return () => signerControl!.current();
}

function enterKey(secret: string): void {
  fireEvent.click(screen.getByRole("tab", { name: "Use secret key (advanced)" }));
  fireEvent.change(screen.getByPlaceholderText("S..."), { target: { value: secret } });
}

const SIGNING_MATERIAL = [Keypair, SecretKeySigner, HashXPreimageSigner];

/** Whether `value` holds a keypair, a signer holding one or a preimage, or the secret itself. */
function holdsSigningMaterial(value: unknown, secret: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (SIGNING_MATERIAL.some((material) => value instanceof material)) return true;
  if (value instanceof Node || "$$typeof" in value) return false;
  const inner =
    value instanceof Map || value instanceof Set ? [...value.values()] : Object.values(value);
  return inner.some((v) => holdsSigningMaterial(v, secret, seen));
}

interface Fiber {
  tag: number;
  memoizedState: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}
interface Hook {
  memoizedState: unknown;
  queue: unknown;
  next: Hook | null;
}

/** Every state value of every component rendered in `container`: useState, useReducer and store
 *  subscriptions (hooks with an update queue), and class state. Refs have no queue. */
function reactStateValues(container: HTMLElement): unknown[] {
  const element = container.querySelector("*") as Element;
  const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$")) as string;
  let fiber = (element as unknown as Record<string, Fiber>)[key] as Fiber;
  while (fiber.return) fiber = fiber.return;
  // The node's fiber may be the stale copy of a double-buffered tree: read the committed one.
  fiber = (fiber as Fiber & { stateNode: { current: Fiber } }).stateNode.current;
  const values: unknown[] = [];
  const visit = (node: Fiber | null): void => {
    for (let f = node; f; f = f.sibling) {
      if (f.tag === 1) values.push(f.memoizedState);
      if ([0, 11, 14, 15].includes(f.tag)) {
        for (let hook = f.memoizedState as Hook | null; hook; hook = hook.next) {
          if (hook.queue) values.push(hook.memoizedState);
        }
      }
      visit(f.child);
    }
  };
  visit(fiber);
  return values;
}

test("execution-wizard › an entered secret key reaches no React state and no store", async () => {
  const key = Keypair.random();
  useDemolishStore.setState({
    accountState: {
      signers: [{ key: key.publicKey(), weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  const held = watchHeldSigner();

  const { container } = render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  const states = reactStateValues(container);
  expect(states.length).toBeGreaterThan(5);
  expect(states.filter((v) => holdsSigningMaterial(v, key.secret()))).toEqual([]);
  expect(holdsSigningMaterial(useDemolishStore.getState(), key.secret())).toBe(false);
  // The scan itself sees signing material where there is some.
  expect(holdsSigningMaterial([{ signer: held()!.signer }], key.secret())).toBe(true);
  expect(holdsSigningMaterial({ text: `x${key.secret()}` }, key.secret())).toBe(true);
});

test("execution-wizard › no component keeps a signer or keypair in useState", () => {
  const web = join(import.meta.dir, "..", "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  const material = /\b(?:SecretKeySigner|HashXPreimageSigner|TransactionSigner|Keypair)\b/;
  const offenders = ["app", "components", "hooks", "store", "lib"]
    .flatMap((dir) => files(join(web, dir)))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      const typed = [...source.matchAll(/use(?:State|Reducer)<([^>]*)>/g)];
      return typed.some(([, type]) => material.test(type ?? ""));
    });
  expect(offenders).toEqual([]);
});

test("execution-wizard › Forget key drops the held key signer", async () => {
  const held = watchHeldSigner();
  render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  fireEvent.click(screen.getByRole("button", { name: /forget key/i }));
  expect(held()).toBeNull();
});

test("execution-wizard › going back to the wallet tab drops the held key signer", async () => {
  const held = watchHeldSigner();
  render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  fireEvent.click(screen.getByRole("tab", { name: "Connect wallet" }));
  expect(held()).toBeNull();
});

test("execution-wizard › a multisig pause drops the held key signer", async () => {
  const held = watchHeldSigner();
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(held()).toBeNull());
  expect(activeSignerText()).toBeNull();
});

test("execution-wizard › leaving the screen drops the held key signer", async () => {
  const held = watchHeldSigner();
  const { unmount } = render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  unmount();
  expect(held()).toBeNull();
});

test("execution-wizard › a finished close drops the held key signer", async () => {
  const held = watchHeldSigner();
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  useDemolishStore.setState({ phase: "COMPLETE" } as never);
  rerender(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(held()).toBeNull());
});

test("execution-wizard › a preimage after a key replaces the held key signer", async () => {
  const preimage = fromHex("deadbeef");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [
      { key: hashXKey, weight: 1, type: "hash_x" },
      { key: cosigner, weight: 1, type: "ed25519_public_key" },
    ],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};
  const held = watchHeldSigner();

  render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));

  fireEvent.change(screen.getByPlaceholderText(/hex-encoded preimage/i), {
    target: { value: "deadbeef" },
  });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));
  await waitFor(() => expect(held()?.kind).toBe("hash-x"));
  expect(held()?.signer).not.toBeInstanceOf(SecretKeySigner);
});

const ends = (key: string) => `${key.slice(0, 6)}…${key.slice(-6)}`;
const keyStandingText = (): string | null =>
  screen.queryByTestId("key-standing")?.textContent ?? null;

function seedSigners(signers: { key: string; weight: number }[]): void {
  useDemolishStore.setState({
    accountState: {
      signers: signers.map((s) => ({ ...s, type: "ed25519_public_key" })),
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
}

function signButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Sign & execute close/ }) as HTMLButtonElement;
}

test("execution-wizard › a key that signs for the account is named with its weight before signing", async () => {
  const key = Keypair.random();
  seedSigners([{ key: key.publicKey(), weight: 2 }]);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());

  await waitFor(() =>
    expect(keyStandingText()).toBe(`Key ${ends(key.publicKey())}: Signer on this account, weight 2`)
  );
  expect(screen.queryByText(NOT_A_SIGNER)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  expect(signButton().disabled).toBe(false);
  expect(signButton().hasAttribute("aria-describedby")).toBe(false);
  fireEvent.click(signButton());
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(key.publicKey());
});

test("execution-wizard › a key that is not a signer holds signing with the reason on screen", async () => {
  const key = Keypair.random();
  seedSigners([{ key: source, weight: 1 }]);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());

  await waitFor(() =>
    expect(keyStandingText()).toBe(`Key ${ends(key.publicKey())}: Not a signer on this account`)
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  const reason = screen.getByText(NOT_A_SIGNER);
  expect(signButton().disabled).toBe(true);
  expect(signButton().getAttribute("aria-describedby")).toBe(reason.id);
  fireEvent.click(signButton());
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a key listed with weight 0 cannot sign", async () => {
  const key = Keypair.random();
  seedSigners([
    { key: source, weight: 1 },
    { key: key.publicKey(), weight: 0 },
  ]);

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());

  await waitFor(() =>
    expect(keyStandingText()).toBe(
      `Key ${ends(key.publicKey())}: Not a signer on this account: its weight is 0`
    )
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  expect(screen.getByText(NOT_A_SIGNER)).toBeDefined();
  expect(signButton().disabled).toBe(true);
});

test("execution-wizard › an invalid key names no account and enables nothing", () => {
  render(<ExecutionWizard network="testnet" />);
  enterKey(`S${"A".repeat(55)}`);

  expect(keyStandingText()).toBeNull();
  expect(activeSignerText()).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Not a valid Stellar secret key");
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  expect(signButton().disabled).toBe(true);
  expect(screen.queryByText(NOT_A_SIGNER)).toBeNull();
});

test("execution-wizard › Add signature is held for a key that is not a signer on the account", async () => {
  const key = Keypair.random();
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());

  await waitFor(() => expect(screen.getByText(NOT_A_SIGNER)).toBeDefined());
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  expect(add.getAttribute("aria-describedby")).toBe(screen.getByText(NOT_A_SIGNER).id);
  expect(screen.queryByText(NOT_STILL_NEEDED)).toBeNull();
});

/** A run that waits at its first signature until `release` is called, then signs as the hook
 *  does: the check before the signature first, the signer only if it passes. */
function heldRun() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const signed = mock(async () => {});
  const outcome: { error: unknown } = { error: null };
  runImpl = async (signer, options) => {
    await gate;
    try {
      await options?.beforeSign?.();
      await signed();
      void signer;
    } catch (err) {
      outcome.error = err;
    }
  };
  return { release: () => release(), signed, outcome };
}

/** Enters a key the account lists and starts the close with it. */
async function startKeyRun() {
  const key = Keypair.random();
  useDemolishStore.setState({
    accountState: {
      signers: [{ key: key.publicKey(), weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 1, med: 1, high: 1 },
    } as never,
  } as never);
  const held = watchHeldSigner();
  const view = render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());
  await waitFor(() => expect(held()?.kind).toBe("secret-key"));
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(screen.getByRole("button", { name: /Sign & execute close/ }));
  return view;
}

test("execution-wizard › a key run left in flight when the screen goes stops before its next signature", async () => {
  const run = heldRun();
  const { unmount } = await startKeyRun();

  unmount();
  await act(async () => run.release());
  expect(run.outcome.error).toBeInstanceOf(SignerReleasedError);
  expect(run.signed).not.toHaveBeenCalled();
});

test("execution-wizard › a run whose signer is still held signs", async () => {
  const run = heldRun();
  await startKeyRun();

  await act(async () => run.release());
  expect(run.outcome.error).toBeNull();
  expect(run.signed).toHaveBeenCalledTimes(1);
});

test("execution-wizard › a hash(x) run stops before its next signature once the screen goes", async () => {
  const preimage = fromHex("deadbeef");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: hashXKey, weight: 1, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const run = heldRun();

  const { unmount } = render(<ExecutionWizard network="testnet" />);
  fireEvent.change(screen.getByPlaceholderText(/hex-encoded preimage/i), {
    target: { value: "deadbeef" },
  });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));

  unmount();
  await act(async () => run.release());
  expect(run.outcome.error).toBeInstanceOf(SignerReleasedError);
  expect(run.signed).not.toHaveBeenCalled();
});

test("execution-wizard › a partly typed key is wiped when the user switches to the wallet tab", () => {
  const Real = secretKeyInputModule.default;
  let keyRef: { current: string } | null = null;
  spyOn(secretKeyInputModule, "default").mockImplementation((props) => {
    keyRef = props.secretKeyRef;
    return Real(props);
  });

  render(<ExecutionWizard network="testnet" />);
  enterKey(Keypair.random().secret().slice(0, 55));
  expect(keyRef!.current).toHaveLength(55);

  fireEvent.click(screen.getByRole("tab", { name: "Connect wallet" }));
  expect(keyRef!.current).toBe("");
});

/** The button's own click handler, called as a stale or tampered UI could: past `disabled`. */
function clickPastDisabled(button: HTMLElement): void {
  const key = Object.keys(button).find((k) => k.startsWith("__reactProps$")) as string;
  const props = (button as unknown as Record<string, { onClick: () => unknown }>)[key]!;
  act(() => void props.onClick());
}

test("execution-wizard › a co-signer added after review is judged by the live round and can sign", async () => {
  const added = Keypair.random();
  seedSigners([{ key: source, weight: 1 }]);
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: added.publicKey(), weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  enterKey(added.secret());

  await waitFor(() =>
    expect(keyStandingText()).toBe(
      `Key ${ends(added.publicKey())}: Signer on this account, weight 1`
    )
  );
  expect(screen.queryByText(NOT_A_SIGNER)).toBeNull();
  const add = screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement;
  expect(add.disabled).toBe(false);
  fireEvent.click(add);
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(added.publicKey());
});

test("execution-wizard › a key whose live weight is 0 cannot sign, whatever the review read", async () => {
  const key = Keypair.random();
  seedSigners([
    { key: source, weight: 1 },
    { key: key.publicKey(), weight: 1 },
  ]);
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: key.publicKey(), weight: 0, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());

  await waitFor(() =>
    expect(keyStandingText()).toBe(
      `Key ${ends(key.publicKey())}: Not a signer on this account: its weight is 0`
    )
  );
  expect(screen.getByText(NOT_A_SIGNER)).toBeDefined();
  expect(
    (screen.getByRole("button", { name: /add signature/i }) as HTMLButtonElement).disabled
  ).toBe(true);
});

test("execution-wizard › signing re-reads the standing and never runs a key that cannot sign", async () => {
  const key = Keypair.random();
  seedSigners([{ key: source, weight: 1 }]);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  enterKey(key.secret());
  await waitFor(() => expect(screen.getByText(NOT_A_SIGNER)).toBeDefined());
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));

  clickPastDisabled(signButton());
  await act(async () => {});
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › Retry is held, with the reason, for a signer that cannot sign", async () => {
  // A wallet the account lists with weight 0 is adopted, and the failed view offers Retry.
  seedSigners([
    { key: source, weight: 1 },
    { key: cosigner, weight: 0 },
  ]);
  currentWalletAddress = cosigner;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "boom" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  await waitFor(() => expect(activeSignerText()).toContain(short(cosigner)));

  const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(retry.getAttribute("aria-describedby")).toBe(screen.getByText(NOT_A_SIGNER).id);
  clickPastDisabled(retry);
  await act(async () => {});
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a preimage for a signer whose live weight is 0 is named but not run", async () => {
  const preimage = fromHex("deadbeef");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    remainingSigners: [{ key: hashXKey, weight: 0, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  fireEvent.change(screen.getByPlaceholderText(/hex-encoded preimage/i), {
    target: { value: "deadbeef" },
  });
  fireEvent.click(screen.getByRole("button", { name: /apply preimage/i }));

  await waitFor(() => expect(screen.getByText(NOT_A_SIGNER)).toBeDefined());
  expect(activeSignerText()).toContain(short(hashXKey));
  expect(runSpy).not.toHaveBeenCalled();
});

test("execution-wizard › a pasted key with surrounding whitespace signs as that key", async () => {
  const key = Keypair.random();
  seedSigners([{ key: key.publicKey(), weight: 1 }]);
  const runSpy = mock(async (_signer: { publicKey: string }) => {});
  runImpl = runSpy;

  render(<ExecutionWizard network="testnet" />);
  enterKey(` ${key.secret()}\n`);

  await waitFor(() => expect(keyStandingText()).toContain("Signer on this account, weight 1"));
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(signButton());
  await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  expect(runSpy.mock.calls[0]?.[0]?.publicKey).toBe(key.publicKey());
});

test("execution-wizard › while a wallet signs, the panel beside its prompt shows that transaction", () => {
  const destination = Keypair.random().publicKey();
  currentProgress = progressAt("wallet-app");
  currentSigningPrompt = {
    walletId: null,
    hash: "ab".repeat(32),
    summary: { mergeDestination: destination, operationCount: 3 },
  };
  render(<ExecutionWizard network="testnet" />);

  expect(screen.getByTestId("pre-sign-destination").textContent).toBe(destination);
  expect(screen.getByTestId("pre-sign-operations").textContent).toBe("3");
  expect(screen.getByTestId("pre-sign-hash").textContent).toBe(hashFingerprint("ab".repeat(32)));
});

test("execution-wizard › no panel is shown while nothing is asked of a wallet", () => {
  currentProgress = progressAt("network");
  render(<ExecutionWizard network="testnet" />);
  expect(screen.queryByTestId("pre-sign-panel")).toBeNull();
});
