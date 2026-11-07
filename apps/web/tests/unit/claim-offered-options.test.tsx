import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import PlanView from "@/components/plan/PlanView";
import { decisionPointsToClaimableBalances } from "@/lib/api/plan-adapters";
import { DECISIONS_VERSION, type DecisionSnapshot } from "@/lib/session/decision-snapshot";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { PlanResponse } from "@/types/close-api";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

// The card used to offer "add a trustline and claim" for every balance the account could not
// claim now, whatever the plan offered. For one whose claim window has not opened, or whose
// trustline the reserve cannot fund, the plan offers forfeiting only, and the transactions
// endpoint refuses any other answer (claimable_balance_not_claimable_now): after review and the
// secret key.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const BALANCE = "00000000c1";
const FORFEIT_NOTE =
  "This balance becomes claimable from 2030-01-01 00:00 UTC, so it cannot be claimed in this close. Leaves 4 LATE unclaimed; permanently inaccessible once the account is merged.";

type Options = PlanResponse["decisionPoints"][number]["options"];

function planWith(options: unknown, currentlyClaimable = false): PlanResponse {
  return {
    planHash: "hash",
    status: "needs_decisions",
    steps: [],
    blockers: [],
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
    execution: { estimatedTransactionCount: 0, transactions: [] },
    decisionPoints: [
      {
        id: `claim:${BALANCE}`,
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: BALANCE,
          asset: `LATE:${ISSUER}`,
          amount: "4.0000000",
          currentlyClaimable,
          predicate: { type: "not", inner: { type: "before_absolute_time", absBeforeEpoch: "1" } },
        },
        options: options as Options,
        default: currentlyClaimable ? "claim" : "",
        required: true,
      },
    ],
  };
}

const FORFEIT_ONLY = [{ id: "forfeit", note: FORFEIT_NOTE }];

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
  claimableBalances: [
    { id: BALANCE, asset: `LATE:${ISSUER}`, amount: "4.0000000", claimants: [], sponsor: null },
  ],
  subEntryMismatch: false,
  defiPositions: emptyDefiPositionsResult(SOURCE),
  defiPositionsWarnings: [],
} as unknown as AccountState;

async function mountView(plan: PlanResponse): Promise<void> {
  await act(async () => {
    render(
      <PlanView
        account={account}
        conversions={[]}
        claimableBalanceDecisions={decisionPointsToClaimableBalances(plan)}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => {}}
        loading={false}
      />
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Claim balances/ }));
  });
}

const readyForDestination = (): boolean =>
  screen.queryByRole("textbox", { name: /Destination address/ }) !== null;

beforeEach(() => {
  window.sessionStorage.clear();
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  window.sessionStorage.clear();
});

test("a balance the plan only lets the account leave offers no trustline to add", async () => {
  await mountView(planWith(FORFEIT_ONLY));

  expect(screen.queryByRole("radio", { name: /trustline/ })).toBeNull();
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.getByText(FORFEIT_NOTE)).toBeTruthy();
  expect(readyForDestination()).toBe(false);

  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: /^Forfeit it/ }));
  });
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({ [BALANCE]: "forfeit" });
  expect(readyForDestination()).toBe(true);
});

for (const [label, options] of [
  ["no options", []],
  ["options that are not a list", "claim"],
  ["options with no recognized answer", [{ id: "convert_to_xlm" }, null, { note: "x" }]],
] as const) {
  test(`${label}: no choice is offered, nothing is claimed by default, and it stays open`, async () => {
    await mountView(planWith(options, true));

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({});
    expect(readyForDestination()).toBe(false);
  });
}

test("the adapter keeps the plan's answers in a fixed order and its reason to leave", () => {
  const [late] = decisionPointsToClaimableBalances(planWith(FORFEIT_ONLY));
  expect(late.offered).toEqual(["forfeit"]);
  expect(late.unclaimableNote).toBe(FORFEIT_NOTE);

  const [now] = decisionPointsToClaimableBalances(
    planWith([{ id: "forfeit" }, { id: "claim", recommended: true }], true)
  );
  expect(now.offered).toEqual(["claim", "forfeit"]);
  expect(now.unclaimableNote).toBeNull();
});

test("an answer the plan does not offer is pruned; others are kept", () => {
  useDemolishStore.setState({
    claimableBalanceSelections: { a: "add_trustline_then_claim", b: "forfeit", c: "claim" },
  });
  useDemolishStore.getState().pruneClaimSelectionsToOffered({ a: ["forfeit"], b: ["forfeit"] });
  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({
    b: "forfeit",
    c: "claim",
  });
});

test("a restored answer the latest plan does not offer is asked again", async () => {
  const snapshot: DecisionSnapshot = {
    v: DECISIONS_VERSION,
    network: "testnet",
    source: SOURCE,
    destination: null,
    memo: null,
    memoType: null,
    destinationAcknowledgedFor: null,
    assetDispositions: {},
    transferDestinations: {},
    claimableBalanceSelections: { [BALANCE]: "add_trustline_then_claim" },
    seen: {},
  };
  window.sessionStorage.setItem(`lumenwipe:decisions:testnet:${SOURCE}`, JSON.stringify(snapshot));
  const plans: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/close/plan")) {
      plans.push(String(init?.body));
      return Response.json(planWith(FORFEIT_ONLY));
    }
    if (url.includes("/account/")) return Response.json(account);
    return Response.json({});
  }) as unknown as typeof fetch);
  const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
    status: "fulfilled",
    value: { network: "testnet" as const },
  });

  await act(async () => {
    render(<AnalyzePage params={params} />);
  });
  await waitFor(() => expect(plans.length).toBe(2));

  expect(useDemolishStore.getState().claimableBalanceSelections).toEqual({});
  expect(plans[0]).toContain("add_trustline_then_claim");
  expect(plans[1]).not.toContain("add_trustline_then_claim");
});
