import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
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
mock.module("@/hooks/useCloseExecution", () => ({
  useCloseExecution: () => ({
    run: (signer: { publicKey: string }) => runImpl(signer),
    progressStatus: null,
    signatureStatus: currentSignatureStatus,
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

test("execution-wizard › normal (non-multisig) failure still shows the retry branch, not signing progress", async () => {
  currentSignatureStatus = null;
  useDemolishStore.setState({ phase: "STEP_FAILED", lastError: "The close failed." } as never);
  runImpl = async () => {};

  render(<ExecutionWizard network="testnet" />);

  expect(await screen.findByRole("button", { name: /retry/i })).toBeDefined();
  expect(screen.queryByText(/more signing weight/)).toBeNull();
  expect(screen.queryByRole("button", { name: /add signature/i })).toBeNull();
});
