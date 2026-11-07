import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";
import PlanStepList from "@/components/review/PlanStepList";
import { activeRegistry } from "@/lib/exchange-registry";
import ReviewView from "@/components/review/ReviewView";
import { expectedReceive } from "@/lib/plan/expected-receive";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep, StepType } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const FOCUSABLE = "input, button, select, textarea, a[href], [tabindex], summary";

function step(index: number, type: StepType, fee = "0.0000100", ops = 1): PlannedStep {
  return {
    index,
    type,
    title: `${type} title`,
    description: `${type} description`,
    operationCount: ops,
    estimatedFeeLumens: fee,
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

// Interleaved types: grouping by type would reorder these.
const STEPS = [
  step(0, "CANCEL_OFFERS", "0.0000200", 2),
  step(1, "REMOVE_TRUSTLINES"),
  step(2, "CANCEL_OFFERS"),
  step(3, "MERGE", "0.0000300", 3),
];

beforeEach(() => {
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.getState().reset();
});

afterEach(() => mock.restore());

test("every step is on screen in plan order, numbered, with its operations and fee", () => {
  render(<PlanStepList steps={STEPS} destinationAddress={DEST} viaRelay={false} />);
  const rows = screen.getAllByTestId("plan-step");
  expect(rows.map((r) => within(r).getByText(/ title$/).textContent)).toEqual([
    "CANCEL_OFFERS title",
    "REMOVE_TRUSTLINES title",
    "CANCEL_OFFERS title",
    "MERGE title",
  ]);
  expect(rows.map((r) => r.textContent?.match(/^\d+\./)?.[0])).toEqual(["1.", "2.", "3.", "4."]);
  expect(rows[0].textContent).toContain("2 operations · fee about 0.00002 XLM");
  expect(rows[1].textContent).toContain("1 operation · fee about 0.00001 XLM");
  expect(rows[3].textContent).toContain("3 operations · fee about 0.00003 XLM");
});

test("nothing in the list is collapsed, hidden or inert", () => {
  const { container } = render(
    <PlanStepList steps={STEPS} destinationAddress={DEST} viaRelay={false} />
  );
  expect(container.querySelector("[inert]")).toBeNull();
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(container.querySelector("[hidden], details")).toBeNull();
  expect(container.innerHTML).not.toContain("grid-rows-[0fr]");
  for (const s of STEPS) expect(container.textContent).toContain(s.description);
});

test("the only focusable controls are the view tabs and the copy button", () => {
  const { container } = render(
    <PlanStepList steps={STEPS} destinationAddress={DEST} viaRelay={false} />
  );
  const reachable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0
  );
  expect(reachable.map((el) => el.getAttribute("role") ?? el.getAttribute("aria-label"))).toEqual([
    "tab",
    "Copy destination address",
  ]);
});

test("grouping by type is a second view, with every step still shown", () => {
  render(<PlanStepList steps={STEPS} destinationAddress={DEST} viaRelay />);
  fireEvent.click(screen.getByRole("tab", { name: "By type" }));
  const groups = screen.getAllByRole("region");
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
    "Cancel offers",
    "Remove trustlines",
    "Merge account",
  ]);
  expect(within(groups[0]).getAllByTestId("plan-step")).toHaveLength(2);
  expect(screen.getByText(/routed through the shared relay account/)).toBeDefined();
});

async function review(): Promise<void> {
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
}

test("the review heads the list with the plan's transaction count", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan(STEPS, "h", 2);
  await review();
  expect(screen.getByTestId("transaction-count").textContent).toBe(
    "About 2 transactions to sign (this can change if your account changes)."
  );
});

test("an unknown count reads at least 1", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan(STEPS, "h", null);
  await review();
  expect(screen.getByTestId("transaction-count").textContent).toMatch(
    /^At least 1 transaction to sign\./
  );
});

test("the fee total sits above the consent, before the button", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan(STEPS);
  await review();
  const fee = screen.getByTestId("fee-summary");
  expect(fee.textContent).toBe(
    "Network fees: about 0.00007 XLM, paid from the account and deducted from what arrives."
  );
  const checkbox = screen.getByRole("checkbox");
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(fee, checkbox)).toBe(true);
  expect(follows(fee, screen.getByRole("button", { name: /want to proceed/i }))).toBe(true);
  expect(screen.queryByText(/in estimated network fees/)).toBeNull();
});

test("with a DeFi exit the review shows one fee, and the hero counts that fee", async () => {
  // The plan's own estimate counts operations only (100 stroops each), not the exit's fee.
  const steps = [step(0, "EXIT_POSITIONS", "0.0500000"), step(1, "MERGE", "0.0000100")];
  const account = {
    nativeBalanceLumens: "20.0000000",
    numSubEntries: 0,
    numSponsoring: 0,
    defiPositions: emptyDefiPositionsResult(SOURCE),
  };
  const planEstimate = expectedReceive({
    account,
    planFeeStroops: "200",
    relayForwardUncounted: false,
    conversions: [],
    dispositions: {},
    claims: [],
    claimSelections: {},
  });
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan(steps);
  useDemolishStore.getState().setExpectedReceive(planEstimate);
  await review();

  expect(screen.getByTestId("fee-summary").textContent).toContain("0.05001 XLM");
  // 20 XLM less the steps' 500100 stroops, not less the plan's 200.
  expect(screen.getByTestId("hero-receive").textContent).toContain("19.94999 XLM");
});

test("a step whose fee cannot be read shows no fee, and the total is not estimated", async () => {
  const steps = [step(0, "CANCEL_OFFERS", "0.0000200"), step(1, "MERGE", "not a fee")];
  render(<PlanStepList steps={steps} destinationAddress={DEST} viaRelay={false} />);
  const rows = screen.getAllByTestId("plan-step");
  expect(rows[0].textContent).toContain("fee about 0.00002 XLM");
  expect(rows[1].textContent).toContain("1 operation · fee not available");
  expect(rows[1].textContent).not.toContain("fee about");
});

test("with an unreadable step fee the review states no fee and no amount", async () => {
  const steps = [step(0, "CANCEL_OFFERS", "0.0000200"), step(1, "MERGE", "")];
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan(steps);
  useDemolishStore.getState().setExpectedReceive(
    expectedReceive({
      account: {
        nativeBalanceLumens: "20.0000000",
        numSubEntries: 0,
        numSponsoring: 0,
        defiPositions: emptyDefiPositionsResult(SOURCE),
      },
      planFeeStroops: "200",
      relayForwardUncounted: false,
      conversions: [],
      dispositions: {},
      claims: [],
      claimSelections: {},
    })
  );
  await review();
  expect(screen.getByTestId("fee-summary").textContent).toBe(
    "Network fees could not be estimated for this plan. They are paid from the account and deducted from what arrives."
  );
  expect(screen.getByTestId("hero-receive").textContent).toBe(
    "The amount you will receive could not be estimated for this plan."
  );
});

test("a fee sent as a JSON number is unknown, not converted", async () => {
  const steps = [step(0, "MERGE", 100 as unknown as string)];
  render(<PlanStepList steps={steps} destinationAddress={DEST} viaRelay={false} />);
  expect(screen.getByTestId("plan-step").textContent).toContain("fee not available");
});

test("with a numeric step fee the review states no fee and does not throw", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan([step(0, "MERGE", 100 as unknown as string)]);
  await review();
  expect(screen.getByTestId("fee-summary").textContent).toMatch(
    /^Network fees could not be estimated/
  );
});

test("steps are numbered and keyed by their place, whatever index the API gave them", () => {
  const steps = [step(7, "CANCEL_OFFERS"), step(7, "REMOVE_TRUSTLINES"), step(2, "MERGE")];
  render(<PlanStepList steps={steps} destinationAddress={DEST} viaRelay={false} />);
  const rows = screen.getAllByTestId("plan-step");
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.textContent?.match(/^\d+\./)?.[0])).toEqual(["1.", "2.", "3."]);
});

test("for a relay close without exits, analyze and review show the same total", async () => {
  const exchange = activeRegistry().entries.find((e) => e.requiresMediator && e.requiresMemo)!;
  const account = {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "20.0000000",
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
  } as never;
  const input = (planFeeStroops: string, relayForwardUncounted: boolean) =>
    expectedReceive({
      account,
      planFeeStroops,
      relayForwardUncounted,
      conversions: [],
      dispositions: {},
      claims: [],
      claimSelections: {},
    });
  // Analyze: the plan asked for without a destination has 2 operations, and the relay's forward
  // payment is added on top.
  const analyze = render(
    <AccountSummaryCard
      account={account}
      destinationAddress={exchange.address}
      expected={input("200", true)}
    />
  );
  const analyzeTotal = analyze
    .getByTestId("expected-receive")
    .textContent?.match(/[\d.]+ XLM/)?.[0];
  analyze.unmount();

  // Review: the final plan's merge step holds the forward payment (2 operations), as the builder
  // counts it, and its estimate was taken with nothing added.
  useDemolishStore.getState().setAddresses(SOURCE, exchange.address, "123");
  useDemolishStore
    .getState()
    .setPlan([step(0, "CANCEL_OFFERS", "0.0000100"), step(1, "MERGE", "0.0000200", 2)]);
  useDemolishStore.getState().setExpectedReceive(input("300", false));
  await review();
  const reviewTotal = screen.getByTestId("hero-receive").textContent?.match(/[\d.]+ XLM/)?.[0];
  expect(analyzeTotal).toBe("19.99997 XLM");
  expect(reviewTotal).toBe(analyzeTotal);
});
