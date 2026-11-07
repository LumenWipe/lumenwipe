import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  Account,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import ExecutionWizard, {
  ALREADY_SIGNED,
  STALE_PROMPT_HOLD_MS,
} from "@/components/execution/ExecutionWizard";
import { useDemolishStore } from "@/store/demolish";
import { InvalidPreAuthTxError } from "@/lib/stellar/pre-auth-tx";
import * as navigation from "next/navigation";
import * as closeExecution from "@/hooks/useCloseExecution";
import type { RunOptions } from "@/hooks/useCloseExecution";
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
  WalletKitSigner,
  WalletNotUsableError,
  WalletSigningTimeoutError,
} from "@/lib/stellar/signer";
import * as walletKitClient from "@/lib/wallet-kit/client";
import type { CloseProgress } from "@/lib/execution/progress";

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
let runImpl: (signer: { publicKey: string }, options?: RunOptions) => Promise<void>;
let submitPreAuthTxImpl: (
  signer: { key: string; weight: number; type: string },
  xdr: string
) => Promise<void>;
function stubCloseExecution(): void {
  spyOn(closeExecution, "useCloseExecution").mockImplementation(
    () =>
      ({
        run: (signer: { publicKey: string }, options?: RunOptions) => runImpl(signer, options),
        progress: currentProgress,
        signatureStatus: currentSignatureStatus,
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
  currentWalletAddress = null;
  currentWalletState = {};
  submitPreAuthTxImpl = async () => {};
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
  expect(retry.nextElementSibling).toBe(note);
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

test("execution-wizard › a successful pre-auth-tx submission calls submitPreAuthTransaction and shows the success state", async () => {
  const preAuthKey = "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJRY";
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: preAuthKey, weight: 1, type: "preauth_tx" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  const submitSpy = mock(
    async (_signer: { key: string; weight: number; type: string }, _xdr: string) => {}
  );
  submitPreAuthTxImpl = submitSpy;

  render(<ExecutionWizard network="testnet" />);

  const textarea = screen.getByPlaceholderText(/paste the pre-authorized transaction xdr/i);
  fireEvent.change(textarea, { target: { value: "AAAAAgAAAAA=" } });
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  expect(await screen.findByText(/pre-authorized transaction submitted/i)).toBeDefined();
  expect(submitSpy).toHaveBeenCalledTimes(1);
  expect(submitSpy.mock.calls[0]?.[0]?.key).toBe(preAuthKey);
  expect(submitSpy.mock.calls[0]?.[1]).toBe("AAAAAgAAAAA=");
});

test("execution-wizard › a rejected pre-auth-tx submission shows an inline error", async () => {
  const preAuthKey = "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJRY";
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    contributed: [],
    remainingSigners: [{ key: preAuthKey, weight: 1, type: "preauth_tx" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};
  submitPreAuthTxImpl = async () => {
    throw new InvalidPreAuthTxError(
      "This transaction's hash does not match the pre-auth-tx signer's key."
    );
  };

  render(<ExecutionWizard network="testnet" />);

  const textarea = screen.getByPlaceholderText(/paste the pre-authorized transaction xdr/i);
  fireEvent.change(textarea, { target: { value: "AAAAAgAAAAA=" } });
  fireEvent.click(screen.getByRole("button", { name: /submit pre-authorized transaction/i }));

  expect(await screen.findByText(/does not match the pre-auth-tx signer's key/i)).toBeDefined();
  expect(screen.queryByText(/pre-authorized transaction submitted/i)).toBeNull();
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
  expect(document.activeElement).toBe(document.body);
});

test("execution-wizard › focus moves to the heading when signing starts and to Retry after a failure", async () => {
  currentWalletAddress = source;
  useDemolishStore.setState({ lastError: "The close failed." } as never);
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  const heading = screen.getByRole("heading", { name: /sign & execute the close/i });

  swapView(rerender, { progress: progressAt("network"), phase: "STEP_EXECUTING" });
  expect(document.activeElement).toBe(heading);

  swapView(rerender, { progress: null, phase: "STEP_FAILED" });
  const retry = await screen.findByRole("button", { name: /retry/i });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(document.activeElement).toBe(retry);
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
  expect(document.activeElement).toBe(screen.getByRole("alert"));
});

test("execution-wizard › a view swap never steals focus from a field being typed in", () => {
  const field = document.createElement("input");
  document.body.appendChild(field);
  const { rerender } = render(<ExecutionWizard network="testnet" />);
  act(() => field.focus());

  swapView(rerender, { progress: progressAt("network"), phase: "STEP_EXECUTING" });
  expect(document.activeElement).toBe(field);
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

test("execution-wizard › a wallet run is checked again before each signature, a key run is not", async () => {
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
  expect(runSpy.mock.calls[0]?.[1]?.beforeSign).toBe(guard);
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
