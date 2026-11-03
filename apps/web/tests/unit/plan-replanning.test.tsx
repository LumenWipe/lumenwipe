import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const account = {
  address: SOURCE,
  network: "testnet",
  sequence: "1",
  nativeBalanceLumens: "10.0000000",
  dataEntries: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
  numSubEntries: 0,
  numSponsoring: 0,
  sponsoredEntries: [],
  sponsorshipEnumerationIncomplete: false,
  sponsoredBy: null,
  authImmutable: false,
  trustlines: [],
  openOffers: [],
  poolShares: [],
  claimableBalances: [],
  subEntryMismatch: false,
  defiPositions: emptyDefiPositionsResult(SOURCE),
  defiPositionsWarnings: [],
} as AccountState;

async function beginButtonWhile(loading: boolean): Promise<HTMLElement> {
  useDemolishStore.getState().reset();
  useDemolishStore.setState({ destinationAddress: DEST, destinationAcknowledgedFor: DEST });
  await act(async () => {
    render(
      <PlanView
        account={account}
        conversions={[]}
        claimableBalanceDecisions={[]}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => {}}
        loading={loading}
      />
    );
  });
  return screen.getByRole("button", { name: /begin execution/i });
}

beforeEach(() => {
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("the close cannot begin while the plan is being updated", async () => {
  expect(((await beginButtonWhile(true)) as HTMLButtonElement).disabled).toBe(true);
});

test("the close can begin once the updated plan has landed", async () => {
  expect(((await beginButtonWhile(false)) as HTMLButtonElement).disabled).toBe(false);
});
