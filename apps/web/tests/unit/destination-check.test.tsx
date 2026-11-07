import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { activeRegistry } from "@/lib/exchange-registry";
import { destinationRefusal } from "@/lib/plan/destination-check";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const PLANTED = Keypair.random().publicKey();

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

const PASSING_ANSWERS = [
  { requiresMediator: false, requiresMemo: false, available: true, reason: "one" },
  {
    requiresMediator: false,
    requiresMemo: false,
    available: false,
    reason: "two",
    memoType: "hash",
    exchangeName: "Planted",
    registryFresh: false,
    destination: PLANTED,
    memo: "planted",
    minAmountOut: "1",
    destMin: "1",
  },
];

function answering(answer: unknown): void {
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) =>
    String(input).includes("/mediator/check/")
      ? Response.json(answer)
      : Response.json({
          status: "ready",
          blockers: [],
          steps: [],
          decisionPoints: [],
          planHash: "h",
        })) as unknown as typeof fetch);
}

/** What the close would carry into signing after the check, and what it asked the API for. */
async function proceedWith(answer: unknown): Promise<{ store: string; planBody: unknown }> {
  useDemolishStore.getState().reset();
  answering(answer);
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
        loading={false}
      />
    );
  });
  fireEvent.click(screen.getByRole("button", { name: /review the full plan/i }));
  await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));

  const planCall = (globalThis.fetch as unknown as ReturnType<typeof spyOn>).mock.calls.find(
    ([url]: unknown[]) => String(url).includes("/close/plan")
  ) as [string, RequestInit];
  const planBody = JSON.parse(String(planCall[1].body));
  // The reset count differs by construction: each run here starts from its own reset.
  const { closeEpoch: _epoch, ...state } = useDemolishStore.getState();
  const store = JSON.stringify(state);
  cleanup();
  mock.restore();
  mockRouter();
  return { store, planBody };
}

function mockRouter(): void {
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
}

beforeEach(mockRouter);

afterEach(() => {
  cleanup();
  mock.restore();
});

test("two answers that both pass leave the same store and the same plan request", async () => {
  const [first, second] = [
    await proceedWith(PASSING_ANSWERS[0]),
    await proceedWith(PASSING_ANSWERS[1]),
  ];
  expect(second).toEqual(first);
  expect(second.store).not.toContain(PLANTED);
});

test("an answer that disagrees with the bundled registry is refused", async () => {
  answering({ requiresMediator: true, available: true });
  expect(await destinationRefusal("testnet", DEST, "")).toContain("could not be confirmed");
});

test("a listed exchange with no relay available is refused", async () => {
  const exchange = activeRegistry().entries.find((e) => e.requiresMediator);
  answering({ requiresMediator: true, available: false });
  expect(await destinationRefusal("testnet", exchange?.address ?? "", "")).toContain(
    "isn't available right now"
  );
});

test("a destination that needs a memo is refused without one and passes with one", async () => {
  answering({ requiresMediator: false, requiresMemo: true });
  expect(await destinationRefusal("testnet", DEST, "")).toContain("needs a memo");
  expect(await destinationRefusal("testnet", DEST, "123")).toBeNull();
});

test("a failed check throws, so the caller shows its own connection message", async () => {
  spyOn(globalThis, "fetch").mockImplementation(
    (async () => new Response("", { status: 503 })) as unknown as typeof fetch
  );
  await expect(destinationRefusal("testnet", DEST, "")).rejects.toThrow("Relay check failed");
});

async function renderReadyPlan(): Promise<void> {
  useDemolishStore.getState().reset();
  answering(PASSING_ANSWERS[0]);
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
        loading={false}
      />
    );
  });
}

test("the memo type chosen for an unlisted destination is the one stored with the memo", async () => {
  await renderReadyPlan();
  fireEvent.click(screen.getByRole("radio", { name: "ID (numbers only)" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Payment memo/ }), {
    target: { value: " 4242 " },
  });

  fireEvent.click(screen.getByRole("button", { name: /review the full plan/i }));
  await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));

  const { memo, memoType } = useDemolishStore.getState();
  expect({ memo, memoType }).toEqual({ memo: "4242", memoType: "id" });
});

test("an optional memo that cannot be sent as typed keeps the button disabled", async () => {
  await renderReadyPlan();
  fireEvent.click(screen.getByRole("radio", { name: "ID (numbers only)" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Payment memo/ }), {
    target: { value: "007" },
  });

  const button = screen.getByRole("button", { name: /review the full plan/i }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("The memo is not valid")).toBeDefined();
});
