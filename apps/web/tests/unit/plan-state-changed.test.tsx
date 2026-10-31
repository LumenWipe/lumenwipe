import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const STALE = "Failed to verify the destination";
const ANALYZE_FAILED = "Failed to analyze account";

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

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

function refused(code: string, status: number): Response {
  return Response.json({ error: { code, message: "refused" } }, { status });
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
        network="testnet"
        onRefresh={() => refreshes++}
        loading={false}
      />
    );
  });
  fireEvent.click(screen.getByRole("button", { name: /begin execution/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  return { refreshes: () => refreshes };
}

test("a state_changed from the final plan says so and refreshes, the same as needs_decisions", async () => {
  const { refreshes } = await proceed(() => refused("state_changed", 409));

  const alert = screen.getByRole("alert").textContent;
  expect(alert).toContain("This account changed while the plan was being prepared");
  expect(alert).not.toContain(STALE);
  expect(refreshes()).toBe(1);
  expect(useDemolishStore.getState().phase).not.toBe("PREFLIGHT_COMPLETE");
});

test("any other refusal of the final plan keeps its own message and does not refresh", async () => {
  const { refreshes } = await proceed(() => refused("internal_error", 500));

  expect(screen.getByRole("alert").textContent).toContain(STALE);
  expect(refreshes()).toBe(0);
});

async function analyze(plan: () => Response): Promise<string | null> {
  stubFetch(plan);
  await act(async () => {
    render(<AnalyzePage params={settled({ network: "testnet" as const })} />);
  });
  return (await screen.findByRole("alert")).textContent;
}

test("a state_changed from the analyze plan says the account changed and how to retry", async () => {
  const message = await analyze(() => refused("state_changed", 409));

  expect(message).toContain("This account changed while the plan was being prepared");
  expect(message).toContain("Refresh the plan");
  expect(message).not.toContain(ANALYZE_FAILED);
});

test("any other refusal of the analyze plan keeps its own message", async () => {
  expect(await analyze(() => refused("internal_error", 500))).toContain(ANALYZE_FAILED);
});
