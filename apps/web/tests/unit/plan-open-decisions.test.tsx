import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const WALLET = Keypair.random().publicKey();

const account = {
  address: SOURCE,
  network: "testnet",
  sequence: "1",
  nativeBalanceLumens: "10.0000000",
  dataEntries: [{ key: "k1", value: "v" }],
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
} as unknown as AccountState;

const NO_ROUTE: AssetConvertibility = {
  asset: "NORT:aaaaaaaa",
  code: "NORT",
  balance: "5",
  convertible: false,
};

function noTrustline(id: string): ClaimableBalanceDecision {
  return {
    balanceId: id,
    asset: "CLMT:aaaaaaaa",
    code: "CLMT",
    amount: "3",
    currentlyClaimable: false,
    predicate: { type: "unconditional" },
    offered: ["add_trustline_then_claim", "forfeit"],
    unclaimableNote: null,
  };
}

function view(conversions: AssetConvertibility[], claims: ClaimableBalanceDecision[]) {
  return (
    <PlanView
      account={account}
      conversions={conversions}
      claimableBalanceDecisions={claims}
      blockers={[]}
      planFeeStroops={null}
      network="testnet"
      onRefresh={() => {}}
      loading={false}
    />
  );
}

async function mount(conversions: AssetConvertibility[], claims: ClaimableBalanceDecision[] = []) {
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    rerender = render(view(conversions, claims)).rerender;
  });
  return async (next: AssetConvertibility[], nextClaims: ClaimableBalanceDecision[]) => {
    await act(async () => rerender(view(next, nextClaims)));
  };
}

const header = (title: string): HTMLElement =>
  screen.getByText(title).closest("button") as HTMLButtonElement;
const button = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /^Review the full plan/ }) as HTMLButtonElement;
const reasons = (): string[] => {
  const list = screen.queryByRole("list", { name: "Before you can review" });
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent ?? "")
    : [];
};
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
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

test("the button is always there, and says exactly what is missing until it enables", async () => {
  await mount([NO_ROUTE]);

  expect(screen.getByRole("heading", { name: "Destination" })).toBeTruthy();
  expect(button().disabled).toBe(true);
  expect(reasons()).toEqual(["Open: 1 asset", "Enter a destination"]);

  await click(screen.getByLabelText(/^Return my 5 NORT to the issuer/));
  expect(reasons()).toEqual(["Enter a destination"]);
  expect(button().disabled).toBe(true);

  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: /Destination address/ }), {
      target: { value: WALLET },
    });
  });
  expect(reasons()).toEqual(["Confirm the destination is a wallet you control"]);

  await click(screen.getByLabelText(/This is a wallet I control/));
  expect(reasons()).toEqual([]);
  expect(button().disabled).toBe(false);
});

test("group chips follow the answers and say informational for groups with nothing to decide", async () => {
  await mount([NO_ROUTE]);
  expect(header("Handle assets").textContent).toContain("Needs your answer (1)");
  expect(header("Remove data").textContent).toContain("Informational");

  await click(screen.getByLabelText(/^Return my 5 NORT to the issuer/));
  expect(header("Handle assets").textContent).toContain("Done");
});

test("the first open group is open on load, and a manual close stands until a new decision", async () => {
  const update = await mount([], [noTrustline("b1")]);
  expect(header("Claim balances").getAttribute("aria-expanded")).toBe("true");

  await click(header("Claim balances"));
  expect(header("Claim balances").getAttribute("aria-expanded")).toBe("false");

  await update([], [noTrustline("b1")]);
  expect(header("Claim balances").getAttribute("aria-expanded")).toBe("false");

  await update([], [noTrustline("b1"), noTrustline("b2")]);
  expect(header("Claim balances").getAttribute("aria-expanded")).toBe("true");
});

test("the jump opens the group and moves focus into the next open decision", async () => {
  await mount([], [noTrustline("b1")]);
  await click(header("Claim balances"));

  await click(screen.getByRole("button", { name: "1 decision left, jump to it" }));

  expect(header("Claim balances").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(
    screen.getByRole("radio", { name: /^Add a CLMT trustline and claim it/ })
  );
});

test("a destination reason moves focus to the field it names", async () => {
  await mount([]);
  await click(screen.getByRole("button", { name: "Enter a destination" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /Destination address/ }));
});

test("the page keeps one live region, and it says a count, not the list", async () => {
  await mount([NO_ROUTE]);
  await click(screen.getByLabelText(/^Return my 5 NORT to the issuer/));

  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0].textContent).toBe("1 thing left before you can review the plan");
});

test("the destination is on screen and fillable before any decision is made", async () => {
  await mount([NO_ROUTE]);
  const input = screen.getByRole("textbox", { name: "Destination address" }) as HTMLInputElement;
  expect(screen.getByText(/You can enter this now\. The button below unlocks/)).toBeDefined();

  fireEvent.change(input, { target: { value: WALLET } });

  expect(input.value).toBe(WALLET);
  expect(button().disabled).toBe(true);
  expect(reasons()).toContain("Open: 1 asset");
  expect(reasons()).not.toContain("Enter a destination");
});

test("a destination reason moves focus to the field while decisions are still open", async () => {
  await mount([NO_ROUTE]);
  const [destination] = screen.getAllByRole("button", { name: "Enter a destination" });
  await click(destination);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Destination address" }));
});

test("a destination typed early survives a re-plan", async () => {
  const replan = await mount([NO_ROUTE]);
  fireEvent.change(screen.getByRole("textbox", { name: "Destination address" }), {
    target: { value: WALLET },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /Payment memo/ }), {
    target: { value: "early" },
  });

  await replan([NO_ROUTE, { ...NO_ROUTE, asset: "MORE:bbbbbbbb", code: "MORE" }], []);

  expect(
    (screen.getByRole("textbox", { name: "Destination address" }) as HTMLInputElement).value
  ).toBe(WALLET);
  expect((screen.getByRole("textbox", { name: /Payment memo/ }) as HTMLInputElement).value).toBe(
    "early"
  );
});
