import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import type { PlanBlocker } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const WALLET = Keypair.random().publicKey();

const account: AccountState = {
  address: SOURCE,
  network: "testnet",
  sequence: "1",
  nativeBalanceLumens: "10.0000000",
  dataEntries: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
  numSubEntries: 1,
  numSponsoring: 0,
  sponsoredEntries: [],
  sponsorshipEnumerationIncomplete: false,
  sponsoredBy: null,
  authImmutable: false,
  trustlines: [
    {
      asset: `USDC:${ISSUER}`,
      code: "USDC",
      issuer: ISSUER,
      balance: "0.0000000",
      authorized: true,
      authorization: "authorized",
      clawbackEnabled: false,
    },
  ],
  openOffers: [],
  poolShares: [],
  claimableBalances: [],
  subEntryMismatch: false,
  defiPositions: {
    ...emptyDefiPositionsResult(SOURCE),
    source: "octopos-degraded-direct-read-confirmed",
    timestamp: null,
    positions: [
      {
        protocol: "blend",
        positionType: "supply",
        contractAddress: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
        assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
        bTokenAmount: "1",
        usdValue: null,
      },
    ],
  },
  defiPositionsWarnings: [],
};

const ASK: PlanBlocker = {
  code: "defi_positions_unavailable",
  message:
    "A direct on-chain check found 1 DeFi position (shown below), and this close includes its exit, but this account also holds trustlines that check cannot rule out. Confirm that they are for other assets, not open DeFi positions, before proceeding.",
};
const DETECTED: PlanBlocker = {
  code: "defi_positions_unconfirmed_but_detected",
  message:
    "A direct on-chain check found 1 DeFi position (shown below), and this close includes its exit.",
};

function view(blockers: PlanBlocker[]) {
  return (
    <PlanView
      account={account}
      conversions={[]}
      claimableBalanceDecisions={[]}
      blockers={blockers}
      planFeeStroops={null}
      network="testnet"
      onRefresh={() => {}}
      loading={false}
    />
  );
}

const reviewButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /^Review the full plan/ }) as HTMLButtonElement;
const reasons = (): string[] => {
  const list = screen.queryByRole("list", { name: "Before you can review" });
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent ?? "")
    : [];
};

beforeEach(() => {
  useDemolishStore.getState().reset();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("a detected position next to a trustline is asked on this page, gated only on its checkbox", async () => {
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    rerender = render(view([ASK])).rerender;
  });

  expect(screen.queryByText("Cannot proceed - blockers found")).toBeNull();
  expect(screen.getByText("Needs verification")).toBeTruthy();
  expect(screen.getByText(/found the DeFi positions shown below/)).toBeTruthy();
  expect(screen.getByText("1 position detected")).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: /Destination address/ }), {
      target: { value: WALLET },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText(/This is a wallet I control/));
  });
  expect(reasons()).toHaveLength(1);
  expect(reviewButton().disabled).toBe(true);

  await act(async () => {
    fireEvent.click(screen.getByLabelText(/I checked this account's trustlines myself/));
  });
  expect(useDemolishStore.getState().defiPositionsAcknowledgedFor).toBe(SOURCE);
  expect(reasons()).toEqual([]);
  expect(reviewButton().disabled).toBe(false);

  await act(async () => rerender(view([DETECTED])));
  expect(screen.getByText("Verified on-chain")).toBeTruthy();
  expect(screen.queryByText("Needs verification")).toBeNull();
});
