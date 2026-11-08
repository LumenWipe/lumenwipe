import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView from "@/components/review/ReviewView";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep } from "@/types/plan";
import { freshAccount } from "./fixtures/fresh-plan";

const SOURCE = Keypair.random().publicKey();
const COSIGNER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const MERGE: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "Merge account",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

beforeEach(() => {
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
});

afterEach(() => mock.restore());

async function show(): Promise<void> {
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
}

test("a two-of-two account is told on the review that both keys sign in this browser", async () => {
  useDemolishStore.getState().setAccountState(
    freshAccount(SOURCE, {
      signers: [
        { key: SOURCE, weight: 1, type: "ed25519_public_key" },
        { key: COSIGNER, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 2, med: 2, high: 2 },
    })
  );
  useDemolishStore
    .getState()
    .setPlan([MERGE], "hash", 1, undefined, [{ order: 0, covers: ["NORMALIZE_SIGNERS", "MERGE"] }]);
  await show();
  expect(screen.getByTestId("multisig-statement").textContent).toBe(
    "This account needs signatures from all 2 of its keys, on 1 transaction of this close. These 2 must sign here, in this browser, during this close. Signing from another device is not supported yet."
  );
});

test("a single-key account gets no multisig statement", async () => {
  useDemolishStore.getState().setAccountState(
    freshAccount(SOURCE, {
      signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 1, high: 1 },
    })
  );
  useDemolishStore
    .getState()
    .setPlan([MERGE], "hash", 1, undefined, [{ order: 0, covers: ["MERGE"] }]);
  await show();
  expect(screen.queryByTestId("multisig-statement")).toBeNull();
});
