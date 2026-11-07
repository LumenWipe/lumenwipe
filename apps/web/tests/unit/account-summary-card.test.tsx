import { afterEach, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";
import { expectedReceive, type ExpectedReceive } from "@/lib/plan/expected-receive";
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

afterEach(cleanup);

const DESTINATION = "GDEST0000000000000000000000000000000000000000000000000ZZ";

function expectedFor(account: AccountState, over: Partial<ExpectedReceive> = {}): ExpectedReceive {
  return {
    ...expectedReceive({
      account,
      planFeeStroops: "100",
      relayForwardUncounted: false,
      conversions: [],
      dispositions: {},
      claims: [],
      claimSelections: {},
    }),
    ...over,
  };
}

function renderCard(
  account: AccountState,
  expected: ExpectedReceive | null = expectedFor(account),
  destination: string | null = null
) {
  return render(
    <AccountSummaryCard account={account} destinationAddress={destination} expected={expected} />
  );
}

test("the summary leads with what the close is expected to deliver, as an estimate", () => {
  const account = baseAccount();
  renderCard(account, expectedFor(account), DESTINATION);
  const lead = screen.getByTestId("expected-receive");
  const body = lead.parentElement!.children;
  expect(body[1]).toBe(lead);
  expect(lead.textContent).toContain(`You will receive about 9.99999 XLM at ${DESTINATION}`);
  expect(screen.getByRole("button", { name: "Copy destination address" })).toBeTruthy();
  expect(lead.textContent).toContain("An estimate, after network fees.");
  expect(lead.textContent).not.toMatch(/guarantee|exactly/i);
  expect(screen.getByText("- 0.00001 XLM")).toBeTruthy();
  expect(screen.getByText("of which locked in reserves")).toBeTruthy();
  expect(screen.getByText("1 XLM")).toBeTruthy();
});

test("with a swap or a claim the note says the figure counts swap minimums", () => {
  const account = baseAccount();
  renderCard(account, expectedFor(account, { estimated: true, swapStroops: "5" }));
  expect(screen.getByText(/counts the least each chosen swap may deliver/)).toBeTruthy();
  expect(screen.getByText("+ 0.0000005 XLM")).toBeTruthy();
});

test("what the figure leaves out is said under it", () => {
  const account = baseAccount();
  renderCard(
    account,
    expectedFor(account, { leavesOutDefiExits: true, unquotedSwaps: 2, tokenSwaps: 1 })
  );
  expect(screen.getByText(/leaves out 2 swaps that have no estimate/)).toBeTruthy();
  expect(screen.getByText(/leaves out the Soroban resource fee each token swap pays/)).toBeTruthy();
  expect(
    screen.getByText(/leaves out any XLM that exiting your DeFi positions pays out/)
  ).toBeTruthy();
});

test("without a plan estimate the counts still render and no figure is shown", () => {
  renderCard(baseAccount(), null);
  expect(screen.queryByTestId("expected-receive")).toBeNull();
  expect(screen.getByText("Trustlines")).toBeTruthy();
});

test("the counts sit in two columns below 640px and cannot overflow at 320px", () => {
  renderCard(baseAccount());
  const list = screen.getByText("Trustlines").closest("ul")!;
  expect(list.className).toMatch(/(^| )grid-cols-2( |$)/);
  expect(list.className).toContain("sm:grid-cols-3");
  for (const item of Array.from(list.children)) {
    expect(item.className).toContain("min-w-0");
  }
});

test("the card computes no amount with floats", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../components/plan/AccountSummaryCard.tsx"),
    "utf8"
  );
  expect(source).not.toMatch(/parseFloat|Number\(|toFixed/);
});

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
