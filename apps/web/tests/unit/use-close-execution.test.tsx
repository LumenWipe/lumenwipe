import { test, expect, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
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
