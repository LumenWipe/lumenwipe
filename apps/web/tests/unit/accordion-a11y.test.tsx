import { test, expect, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import PlanAccordion from "@/components/plan/PlanAccordion";
import PlanStepAccordion from "@/components/review/PlanStepAccordion";
import Faq from "@/components/marketing/Faq";
import type { AccountState } from "@/types/account";
import type { PlannedStep, StepType } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

afterEach(cleanup);

const ADDRESS = "GSOURCE0000000000000000000000000000000000000000000000000";
const FOCUSABLE = "input, button, select, textarea, a[href], [tabindex]";

function account(): AccountState {
  return {
    address: ADDRESS,
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
    defiPositions: emptyDefiPositionsResult(ADDRESS),
    defiPositionsWarnings: [],
  } as AccountState;
}

function step(index: number, type: StepType): PlannedStep {
  return {
    index,
    type,
    title: `${type} title`,
    description: `${type} description`,
    operationCount: 1,
    estimatedFeeLumens: "0.00001",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

function renderPlan() {
  return render(
    <PlanAccordion
      account={account()}
      conversions={[
        { asset: "USDC:GISSUER", code: "USDC", balance: "5.0000000", convertible: true },
      ]}
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

function renderSteps() {
  return render(
    <PlanStepAccordion
      steps={[step(0, "CANCEL_OFFERS"), step(1, "MERGE")]}
      destinationAddress={null}
      mediatorRequired={false}
    />
  );
}

function expectWired(container: HTMLElement): void {
  const headers = Array.from(container.querySelectorAll("button[aria-expanded]"));
  expect(headers.length).toBeGreaterThan(1);
  for (const header of headers) {
    const panel = container.querySelector(`[id="${header.getAttribute("aria-controls")}"]`);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("region");
    expect(panel?.getAttribute("aria-labelledby")).toBe(header.id);
    expect(panel?.hasAttribute("inert")).toBe(header.getAttribute("aria-expanded") === "false");
  }
}

test("plan accordion › every header controls a labelled region that is inert only when closed", () => {
  const { container } = renderPlan();
  expectWired(container);
});

test("plan accordion › a closed panel's controls sit inside an inert subtree", () => {
  const { container } = renderPlan();
  const assetsHeader = screen.getByText("Handle assets").closest("button") as HTMLButtonElement;
  const panel = container.querySelector(`[id="${assetsHeader.getAttribute("aria-controls")}"]`);
  const controls = panel?.querySelectorAll(FOCUSABLE) ?? [];
  expect(controls.length).toBeGreaterThan(0);

  fireEvent.click(screen.getByText("Remove data").closest("button") as HTMLButtonElement);

  expect(assetsHeader.getAttribute("aria-expanded")).toBe("false");
  for (const control of Array.from(controls)) {
    expect(control.closest("[inert]")).not.toBeNull();
  }
  expect(panel?.textContent).toContain("USDC");
});

test("plan accordion › reopening a panel removes inert", () => {
  const { container } = renderPlan();
  const header = screen.getByText("Remove data").closest("button") as HTMLButtonElement;
  const panel = container.querySelector(`[id="${header.getAttribute("aria-controls")}"]`);
  expect(panel?.hasAttribute("inert")).toBe(true);

  fireEvent.click(header);

  expect(panel?.hasAttribute("inert")).toBe(false);
  expect(within(panel as HTMLElement).getByText("k1")).toBeTruthy();
});

test("step accordion › every header controls a labelled region that is inert only when closed", () => {
  const { container } = renderSteps();
  expectWired(container);
  const merge = screen.getByText("Merge account").closest("button") as HTMLButtonElement;
  fireEvent.click(merge);
  expectWired(container);
  expect(merge.getAttribute("aria-expanded")).toBe("true");
});

test("faq › every header controls a labelled region that is inert only when closed", () => {
  const { container } = render(<Faq />);
  expectWired(container);
  const second = screen.getByText("Is closing an account reversible?").closest("button");
  fireEvent.click(second as HTMLButtonElement);
  expectWired(container);
  expect(second?.getAttribute("aria-expanded")).toBe("true");
});
