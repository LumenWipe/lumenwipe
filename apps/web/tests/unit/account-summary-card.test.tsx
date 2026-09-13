import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";
import type { AccountState } from "@/types/account";
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

function renderCard(account: AccountState) {
  return render(
    <AccountSummaryCard account={account} destinationAddress={null} totalFee="0.0000100" />
  );
}

test("a real OctoPos snapshot shows the octopos verification badge", () => {
  renderCard(
    baseAccount({ defiPositions: emptyDefiPositionsResult(ADDRESS, "mainnet") }) // source: "empty"
  );
  expect(screen.getByText("Verified with OctoPos")).toBeDefined();
});

test("a confirmed-empty direct read shows the lumenwipe verification badge", () => {
  renderCard(
    baseAccount({
      defiPositions: {
        ...emptyDefiPositionsResult(ADDRESS, "mainnet"),
        source: "octopos-degraded-direct-read-confirmed",
        timestamp: null,
      },
    })
  );
  expect(screen.getByText("Verified by LumenWipe")).toBeDefined();
});

test("a confirmed sweep with a real detected position also shows the lumenwipe badge", () => {
  renderCard(
    baseAccount({
      defiPositions: {
        ...emptyDefiPositionsResult(ADDRESS, "mainnet"),
        source: "octopos-degraded-direct-read-confirmed",
        timestamp: null,
        positions: [
          {
            protocol: "blend",
            positionType: "supply",
            contractAddress: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
            assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
            bTokenAmount: "99997766",
            usdValue: null,
          },
        ],
      },
    })
  );
  expect(screen.getByText("Verified by LumenWipe")).toBeDefined();
  expect(screen.getByText("1")).toBeDefined();
});

test("a totally unconfirmed degraded result shows no verification badge", () => {
  renderCard(
    baseAccount({
      defiPositions: {
        ...emptyDefiPositionsResult(ADDRESS, "mainnet"),
        source: "octopos-degraded-fallback",
        timestamp: null,
      },
    })
  );
  expect(screen.queryByText(/Verified (with|by)/)).toBeNull();
});
