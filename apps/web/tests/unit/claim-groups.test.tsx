import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { claimGroups } from "@/lib/plan/open-items";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = "aaaaaaaa";

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
} as unknown as AccountState;

type Kind = "now" | "trustline" | "late" | "unreadable";

const OFFERED: Record<Kind, ClaimableBalanceSelection[]> = {
  now: ["claim", "forfeit"],
  trustline: ["add_trustline_then_claim", "forfeit"],
  late: ["forfeit"],
  unreadable: [],
};

function balance(id: string, code: string, kind: Kind, amount = "1"): ClaimableBalanceDecision {
  return {
    balanceId: id,
    asset: `${code}:aaaaaaaa`,
    code,
    amount,
    currentlyClaimable: kind === "now",
    predicate: { type: "unconditional" },
    offered: OFFERED[kind],
    unclaimableNote: null,
  };
}

function many(code: string, kind: Kind, n: number): ClaimableBalanceDecision[] {
  return Array.from({ length: n }, (_, i) => balance(`${code}-${i + 1}`, code, kind));
}

function view(claims: ClaimableBalanceDecision[]) {
  return (
    <PlanView
      account={account}
      conversions={[]}
      claimableBalanceDecisions={claims}
      blockers={[]}
      planFeeStroops={null}
      network="testnet"
      onRefresh={() => {}}
      loading={false}
    />
  );
}

async function mount(claims: ClaimableBalanceDecision[]) {
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    rerender = render(view(claims)).rerender;
  });
  return async (next: ClaimableBalanceDecision[]) => {
    await act(async () => rerender(view(next)));
  };
}

const selections = () => useDemolishStore.getState().claimableBalanceSelections;
const section = (code: string): HTMLElement =>
  screen.getByRole("region", { name: `${code} claimable balances` });
async function press(code: string, name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(within(section(code)).getByRole("button", { name }));
  });
}
const answersOf = (prefix: string) =>
  Object.entries(selections())
    .filter(([id]) => id.startsWith(`${prefix}-`))
    .map(([, s]) => s);

beforeEach(() => {
  useDemolishStore.getState().reset();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("36 balances across 3 assets render grouped, and a bulk answer touches only its group", async () => {
  await mount([
    ...many("AAA", "now", 12),
    ...many("BBB", "now", 12),
    ...many("CCC", "trustline", 12),
  ]);

  for (const code of ["AAA", "BBB", "CCC"]) {
    expect(section(code).textContent).toContain(`${code} · 12 balances · 12 ${code} in total`);
  }
  expect(screen.getByText("24 of 36 answered")).toBeTruthy();
  expect(within(section("CCC")).queryByRole("button", { name: "Claim all" })).toBeNull();
  expect(section("CCC").textContent).toContain("12 balances need their own answer below.");

  await press("AAA", "Leave all unclaimed");

  expect(answersOf("AAA")).toEqual(Array(12).fill("forfeit"));
  expect(answersOf("BBB")).toEqual(Array(12).fill("claim"));
  expect(answersOf("CCC")).toEqual([]);
  expect(section("AAA").textContent).toContain("Set 12 AAA balances to be left unclaimed.");
  const [status] = screen.getAllByRole("status");
  expect(status.textContent).toBe("Set 12 AAA balances to be left unclaimed.");
});

test("in a mixed group a bulk answer skips what cannot be claimed now or has no choice", async () => {
  const claims = [
    ...many("MIX", "now", 3),
    balance("MIX-late", "MIX", "late"),
    balance("MIX-unreadable", "MIX", "unreadable"),
  ];
  await mount(claims);
  expect(section("MIX").textContent).toContain("2 balances need their own answer below.");

  await press("MIX", "Leave all unclaimed");
  expect(selections()).toEqual({ "MIX-1": "forfeit", "MIX-2": "forfeit", "MIX-3": "forfeit" });

  await press("MIX", "Claim all");
  expect(selections()).toEqual({ "MIX-1": "claim", "MIX-2": "claim", "MIX-3": "claim" });
});

test("a bulk leave can be undone, and undo puts back only what the latest plan offers", async () => {
  const claims = many("AAA", "now", 4);
  const update = await mount(claims);
  await act(async () => {
    fireEvent.click(screen.getAllByRole("radio", { name: /^Leave it unclaimed/ })[0]);
  });

  await press("AAA", "Leave all unclaimed");
  expect(answersOf("AAA")).toEqual(Array(4).fill("forfeit"));

  // The next plan can no longer claim AAA-2 and no longer lists AAA-3.
  await update([claims[0], balance("AAA-2", "AAA", "late"), claims[3]]);
  await press("AAA", "Undo");

  expect(selections()).toEqual({
    "AAA-1": "forfeit",
    "AAA-2": "forfeit",
    "AAA-3": "forfeit",
    "AAA-4": "claim",
  });
  expect(within(section("AAA")).queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a balance that appears after a bulk answer is not answered by it", async () => {
  const update = await mount([...many("AAA", "now", 2), ...many("CCC", "trustline", 1)]);
  await press("AAA", "Leave all unclaimed");

  await update([
    ...many("AAA", "now", 3),
    ...many("CCC", "trustline", 1),
    balance("CCC-2", "CCC", "trustline"),
  ]);

  // The newcomer gets the plan's own default, not the group's earlier answer.
  expect(selections()["AAA-3"]).toBe("claim");
  expect(selections()["CCC-2"]).toBeUndefined();
  expect(screen.getByText("3 of 5 answered")).toBeTruthy();
});

test("answering updates the counts and a fully answered group collapses", async () => {
  await mount(many("CCC", "trustline", 2));
  const details = section("CCC").querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(true);
  expect(section("CCC").textContent).toContain("0 of 2 answered");

  const leave = within(section("CCC")).getAllByRole("radio", { name: /^Leave it unclaimed/ });
  await act(async () => {
    fireEvent.click(leave[0]);
  });
  expect(screen.getByText("1 of 2 answered", { selector: "p" })).toBeTruthy();
  expect(details.open).toBe(true);

  await act(async () => {
    fireEvent.click(leave[1]);
  });
  expect(details.open).toBe(false);
});

test("a claimable-now balance offers two radios, claim by default, and a note on leave", async () => {
  await mount([balance("ONE-1", "ONE", "now", "4")]);
  const claim = screen.getByRole("radio", { name: /^Claim it/ }) as HTMLInputElement;
  const leave = screen.getByRole("radio", { name: /^Leave it unclaimed/ }) as HTMLInputElement;
  expect(claim.checked).toBe(true);
  expect(screen.queryByText(/unreachable once the account is merged/)).toBeNull();

  await act(async () => {
    fireEvent.click(leave);
  });
  expect(selections()).toEqual({ "ONE-1": "forfeit" });
  const note = screen.getByText(/This balance will be unreachable once the account is merged/);
  expect(note.className).toContain("text-fg");
  expect(note.closest('[role="status"]')).toBeNull();
});

test("totals are summed in stroops, exactly, past what a float can hold", () => {
  const [group] = claimGroups(
    [
      balance("X-1", "BIG", "now", "922337203685.4775807"),
      balance("X-2", "BIG", "now", "922337203685.4775807"),
      balance("X-3", "BIG", "now", "0.0000001"),
    ],
    {}
  );
  expect(group.total).toBe("1844674407370.9551615");
  expect(group.bulkIds).toEqual(["X-1", "X-2", "X-3"]);

  const [unreadable] = claimGroups([balance("Y-1", "BAD", "now", "1e3")], {});
  expect(unreadable.total).toBeNull();
});
