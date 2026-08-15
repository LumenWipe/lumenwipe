import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
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

const source = Keypair.random().publicKey();
const cosigner = Keypair.random().publicKey();

beforeEach(() => {
  currentSignatureStatus = null;
  currentWalletAddress = null;
  useDemolishStore.setState({
    executionPlan: [{ id: "s1" } as never],
    sourceAddress: source,
    destinationAddress: Keypair.random().publicKey(),
    mediatorRequired: false,
    phase: "STEP_EXECUTING",
    lastError: null,
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

test("execution-wizard › switching to a second wallet updates weight without resetting progress", async () => {
  currentSignatureStatus = {
    requiredWeight: 2,
    accumulatedWeight: 1,
    remainingSigners: [{ key: cosigner, weight: 1, type: "ed25519_public_key" }],
  };
  useDemolishStore.setState({ phase: "STEP_FAILED" } as never);

  const setItemSpy = mock((..._args: unknown[]) => {});
  const originalSetItem = window.sessionStorage.setItem.bind(window.sessionStorage);
  window.sessionStorage.setItem = setItemSpy as typeof originalSetItem;

  runImpl = async () => {
    // Simulate the second signer clearing the threshold.
    currentSignatureStatus = null;
    useDemolishStore.setState({ phase: "COMPLETE" } as never);
  };

  render(<ExecutionWizard network="testnet" />);
  currentWalletAddress = cosigner; // second wallet connects, matching a remaining signer

  const addButton = await screen.findByRole("button", { name: /add signature/i });
  expect(addButton).toBeDefined();

  window.sessionStorage.setItem = originalSetItem;
  expect(setItemSpy).not.toHaveBeenCalled();
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
