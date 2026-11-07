// The plan fetched on proceed carries its own transaction count; it must reach the store with
// the plan, since /review reads it from there.
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function account(): AccountState {
  return {
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
  };
}

function stubFetch(plan: () => Response): void {
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/close/plan")) return plan();
    if (url.includes("/mediator/check/")) {
      return Response.json({ requiresMediator: false, available: true });
    }
    if (url.includes("/account/")) return Response.json(account());
    return Response.json({});
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  const router = { push: () => {}, replace: () => {} };
  const params = new URLSearchParams(`source=${SOURCE}`);
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => params as unknown as ReturnType<typeof navigation.useSearchParams>
  );
});

afterEach(() => {
  mock.restore();
});

async function proceed(plan: () => Response): Promise<{ refreshes: () => number }> {
  stubFetch(plan);
  useDemolishStore.setState({ destinationAddress: DEST, destinationAcknowledgedFor: DEST });
  let refreshes = 0;
  await act(async () => {
    render(
      <PlanView
        account={account()}
        conversions={[]}
        claimableBalanceDecisions={[]}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => refreshes++}
        loading={false}
      />
    );
  });
  fireEvent.click(screen.getByRole("button", { name: /review the full plan/i }));
  await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));
  return { refreshes: () => refreshes };
}

const MERGE = {
  index: 0,
  type: "MERGE",
  title: "Merge account",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
};

test("the final plan's transaction count is kept for the review", async () => {
  const { refreshes } = await proceed(() =>
    Response.json({
      planHash: "final",
      status: "ready",
      steps: [MERGE],
      decisionPoints: [],
      blockers: [],
      estimate: { feeStroops: "100", freedReserveXlm: "1.0000000" },
      execution: { estimatedTransactionCount: 3, transactions: [] },
    })
  );
  const state = useDemolishStore.getState();
  expect(refreshes()).toBe(0);
  expect(state.planHash).toBe("final");
  expect(state.estimatedTransactionCount).toBe(3);
});
