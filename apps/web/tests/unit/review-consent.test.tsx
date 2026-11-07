import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView from "@/components/review/ReviewView";
import type { Network } from "@/config/networks";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep } from "@/types/plan";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const STEP: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "MERGE",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

function expected(totalStroops: string): ExpectedReceive {
  return {
    totalStroops,
    balanceStroops: "125000100",
    reserveStroops: "10000000",
    feeStroops: "100",
    swapStroops: "0",
    claimStroops: "0",
    estimated: false,
    unquotedSwaps: 0,
    tokenSwaps: 0,
    flaggedSwaps: 0,
    leavesOutDefiExits: false,
  };
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

async function show(network: Network = "mainnet") {
  await act(async () => {
    render(<ReviewView network={network} />);
  });
}

function consent(): HTMLElement {
  return screen.getByTestId("review-consent-row");
}

beforeEach(() => {
  useNetworkStore.setState({ network: "mainnet" });
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan([STEP]);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
  useDemolishStore.getState().setExpectedReceive(expected("125000000"));
  spyOn(navigation, "useRouter").mockImplementation(
    () => ({ push: () => {}, replace: () => {} }) as never
  );
});

afterEach(() => mock.restore());

test("the consent names the account, the network, the amount and the destination", async () => {
  await show();
  const text = consent().textContent ?? "";
  expect(text).toContain(`closing ${short(SOURCE)}`);
  expect(text).toContain("on MAINNET");
  // The hero's figure: the balance less the one fee figure the steps add up to.
  expect(text).toContain("about 12.5 XLM");
  expect(text).toContain(`to ${short(DEST)}.`);
  expect(text).toBe(
    `I confirm closing ${short(SOURCE)} on MAINNET and sending about 12.5 XLM to ${short(DEST)}.`
  );
});

test("the consent names the testnet on a testnet close", async () => {
  await show("testnet");
  expect(consent().textContent).toContain("on TESTNET");
});

test("the consent does not invent an amount the plan could not estimate", async () => {
  useDemolishStore.getState().setExpectedReceive(null);
  await show();
  expect(consent().textContent).toContain("sending what is left of its balance to");
  expect(consent().textContent).not.toContain("XLM");
});

test("the consent does not promise an amount the fees would swallow", async () => {
  useDemolishStore.getState().setExpectedReceive({
    ...expected("-1"),
    balanceStroops: "99",
  });
  await show();
  expect(consent().textContent).toContain("what is left after fees, which may be nothing,");
  expect(consent().textContent).not.toContain("about 0 XLM");
});

test("the whole destination stands directly above the consent", async () => {
  await show();
  const above = consent().previousElementSibling as HTMLElement;
  expect(above.textContent).toContain("Destination:");
  expect(above.textContent).toContain(DEST);
});

test("the consent row holds the 44px minimum hit area", async () => {
  await show();
  expect(consent().tagName).toBe("LABEL");
  expect(consent().className).toContain("min-h-control");
  expect(consent().querySelector('input[type="checkbox"]')).not.toBeNull();
});

test("the disabled button says why, and stops saying it once the box is ticked", async () => {
  await show();
  const button = screen.getByRole("button", { name: "Continue to signing" });
  expect(button).toHaveProperty("disabled", true);
  const why = screen.getByText("Tick the box to continue");
  expect(button.getAttribute("aria-describedby")).toBe(why.id);
  expect(why.id).not.toBe("");

  fireEvent.click(screen.getByRole("checkbox"));

  expect(button).toHaveProperty("disabled", false);
  expect(button.getAttribute("aria-describedby")).toBeNull();
  expect(screen.queryByText("Tick the box to continue")).toBeNull();
});

test("what happens next is said in four statements, and only the last is in the red box", async () => {
  await show();
  const section = screen.getByRole("region", { name: "What happens next" });
  const items = [...section.querySelectorAll("ol > li")].map((li) => li.textContent);
  expect(items).toEqual([
    "You sign each transaction; nothing is sent until you do.",
    "Your first signature starts changes that cannot be undone, such as swaps, returns to issuer and removed trustlines.",
    "If you stop midway the account stays open and partly cleaned up, and you can resume.",
    "The final transaction permanently closes the account.",
  ]);
  expect(screen.getByTestId("review-final-warning").textContent).toBe(
    "The final transaction permanently closes the account."
  );
});

test("a resumed close says nothing more is sent, since earlier transactions may have been", async () => {
  useDemolishStore.setState({ sessionId: "s" });
  await show();
  const section = screen.getByRole("region", { name: "What happens next" });
  expect(section.querySelector("ol > li")?.textContent).toBe(
    "You sign each transaction; nothing more is sent until you do."
  );
});

test("the safety line says the checks happen before each signature, not that they happened", async () => {
  await show();
  const text = document.body.textContent ?? "";
  expect(text).toContain(
    "Before you sign each transaction, we check its destination, memo and operations against what you chose."
  );
  expect(text).not.toMatch(/every transaction above is verified/i);
});

test("a review the journey does not allow the resume promise in says only what stopping leaves", async () => {
  useDemolishStore.setState({ phase: "ANALYZING" });
  await show();
  const section = screen.getByRole("region", { name: "What happens next" });
  expect(section.querySelectorAll("ol > li")[2]?.textContent).toBe(
    "If you stop midway the account stays open and partly cleaned up."
  );
});

test("the consent names the memo as the hero shows it, escapes included", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST, "ab​cd", "text");
  await show();
  const text = consent().textContent ?? "";
  expect(text).toBe(
    `I confirm closing ${short(SOURCE)} on MAINNET and sending about 12.5 XLM to ${short(DEST)} with memo text: ab\\u{200B}cd (7 bytes).`
  );
  expect(text).not.toContain("​");
  expect(consent().querySelector('[data-testid="memo-escape"]')?.textContent).toBe("\\u{200B}");
});

test("the consent says no memo when none is set", async () => {
  await show();
  expect(consent().textContent).not.toContain("memo");
});
