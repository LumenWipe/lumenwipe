import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { hash, Keypair, StrKey } from "@stellar/stellar-sdk";
import ExecutionWizard from "@/components/execution/ExecutionWizard";
import { useDemolishStore } from "@/store/demolish";

// ExecutionWizard calls useRouter() (to navigate to /complete on success) - outside of a
// real Next.js app router tree that throws "invariant expected app router to be mounted".
// This test never reaches the COMPLETE-phase navigation itself, so a no-op stub is enough.
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));

// Mocks kept minimal and behavior-focused: this test exercises ExecutionWizard's own
// state machine (signature-progress rendering, signer switching, no persisted writes),
// not the full close pipeline - that's Task 3/4's job.
let runImpl: (signer: { publicKey: string }) => Promise<void>;
let submitPreAuthTxImpl: (
  signer: { key: string; weight: number; type: string },
  xdr: string
) => Promise<void>;
mock.module("@/hooks/useCloseExecution", () => ({
  useCloseExecution: () => ({
    run: (signer: { publicKey: string }) => runImpl(signer),
    progressStatus: null,
    signatureStatus: currentSignatureStatus,
    submitPreAuthTransaction: (
      signer: { key: string; weight: number; type: string },
      xdr: string
    ) => submitPreAuthTxImpl(signer, xdr),
  }),
}));

let currentSignatureStatus: {
  requiredWeight: number;
  accumulatedWeight: number;
  remainingSigners: { key: string; weight: number; type: string }[];
} | null = null;

let currentWalletAddress: string | null = null;
mock.module("@/hooks/useWalletKitConnection", () => ({
  useWalletKitConnection: () => ({
    address: currentWalletAddress,
    connecting: false,
    error: null,
    networkMismatch: false,
    connect: async () => {},
    disconnect: async () => {},
  }),
}));

// The app's real resumable session mechanism is IndexedDB via saveSession
// (apps/web/lib/session/store.ts), not sessionStorage - the only real sessionStorage.setItem
// caller anywhere in apps/web is an unrelated risk-disclaimer modal. Mocking this module (not
// spying on sessionStorage) is what actually lets the "no session-store write between two
// signers" assertion below catch a real regression, since it intercepts every import of the
// module across ExecutionWizard's render tree, not just a direct call from this component.
const mockSaveSession = mock(async (..._args: unknown[]) => {});
mock.module("@/lib/session/store", () => ({
  saveSession: mockSaveSession,
  loadSession: async () => null,
  listSessions: async () => [],
  deleteSession: async () => {},
}));

const source = Keypair.random().publicKey();
const cosigner = Keypair.random().publicKey();

beforeEach(() => {
  currentSignatureStatus = null;
  currentWalletAddress = null;
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
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByText(/1 more signing weight/)).toBeDefined();
  expect(screen.getByText(/hasn't signed yet/)).toBeDefined();
  expect(screen.getByRole("button", { name: /add signature/i })).toBeDefined();
});

test("execution-wizard › connecting a second (co-signer) wallet enables and drives the Add signature CTA", async () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
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
  const preimage = Buffer.from("deadbeef", "hex");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    remainingSigners: [{ key: hashXKey, weight: 1, type: "hash_x" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByText(/hash\(x\) signer/i)).toBeDefined();
  expect(screen.getByPlaceholderText(/hex-encoded preimage/i)).toBeDefined();
  // Not lumped into the generic "can't yet contribute automatically" line.
  expect(screen.queryByText(/can't yet contribute automatically/i)).toBeNull();
});

test("execution-wizard › a correct hash(x) preimage calls run() with a signer keyed to the hash(x) signer", async () => {
  const preimage = Buffer.from("deadbeef", "hex");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
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
  const hashXKey = StrKey.encodeSha256Hash(hash(Buffer.from("deadbeef", "hex")));
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
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

// #102: pre-auth-tx signer support.
test("execution-wizard › a preauth_tx signer among remainingSigners renders its explanation, an XDR textarea, and the persistent warning", async () => {
  const preAuthKey = "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJRY"; // any-shaped preauth key for display purposes
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
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
    remainingSigners: [{ key: preAuthKey, weight: 1, type: "preauth_tx" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};
  submitPreAuthTxImpl = async () => {
    throw new Error("This transaction's hash does not match the pre-auth-tx signer's key.");
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
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  // The progress panel already says what remains; a second banner restating the
  // requirement would be noise.
  expect(screen.queryByTestId("multisig-notice")).toBeNull();
});
