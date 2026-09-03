import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import PlanAccordion from "@/components/plan/PlanAccordion";
import type { AccountState, DefiPosition, UnrecognizedDefiPosition } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const ADDRESS = "GSOURCE0000000000000000000000000000000000000000000000000";

function baseAccount(over: Partial<AccountState> = {}): AccountState {
  return {
    address: ADDRESS,
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
    defiPositions: emptyDefiPositionsResult(ADDRESS),
    defiPositionsWarnings: [],
    ...over,
  };
}

function renderAccordion(account: AccountState) {
  return render(
    <PlanAccordion
      account={account}
      conversions={[]}
      assetDispositions={{}}
      transferDestinations={{}}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      claimableBalanceDecisions={[]}
      claimableBalanceSelections={{}}
      onSelectClaimableBalance={() => {}}
      destinationAddress={null}
      mediatorRequired={false}
    />
  );
}

test("plan-accordion positions › no group renders with no positions and no warnings", () => {
  renderAccordion(baseAccount());
  expect(screen.queryByText("DeFi positions")).toBeNull();
});

test("plan-accordion positions › renders a detected position", () => {
  const position: DefiPosition = {
    protocol: "aquarius",
    positionType: "lp",
    contractAddress: "CPOOL",
    usdValue: null,
    shareAmount: "420000000",
  };
  const account = baseAccount({
    defiPositions: {
      ...emptyDefiPositionsResult(ADDRESS),
      positions: [position],
    },
  });

  renderAccordion(account);
  expect(screen.getByText("DeFi positions")).toBeDefined();
  expect(screen.getByText("1 position detected")).toBeDefined();
});

test("plan-accordion positions › a degraded read with zero positions still shows a warning", () => {
  const account = baseAccount({
    defiPositions: {
      ...emptyDefiPositionsResult(ADDRESS),
      timestamp: null,
      source: "octopos-degraded-fallback",
    },
    defiPositionsWarnings: [
      {
        code: "defi_positions_unavailable",
        message: "DeFi position data for this account could not be confirmed.",
      },
    ],
  });

  renderAccordion(account);
  expect(screen.getByText("DeFi positions")).toBeDefined();
  expect(screen.getByText("Could not be confirmed - verify manually")).toBeDefined();
  expect(
    screen.getByText("DeFi position data for this account could not be confirmed.")
  ).toBeDefined();
});

test("plan-accordion positions › unrecognized positions render distinctly from recognized ones", () => {
  const unrecognized: UnrecognizedDefiPosition = {
    protocol: "blend",
    rawType: "SUPPLY",
    reason: "missing reserve index",
  };
  const account = baseAccount({
    defiPositions: {
      ...emptyDefiPositionsResult(ADDRESS),
      unrecognizedPositions: [unrecognized],
    },
  });

  renderAccordion(account);
  expect(
    screen.getByText(/Blend position could not be read \(missing reserve index\)/)
  ).toBeDefined();
});
