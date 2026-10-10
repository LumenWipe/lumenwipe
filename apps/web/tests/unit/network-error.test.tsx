import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NetworkError from "@/app/[network]/error";
import { useDemolishStore } from "@/store/demolish";
import * as navigation from "next/navigation";
import type { DemolishPhase, PlannedStep, StepStatus, StepType } from "@/types/plan";

function step(index: number, type: StepType, status: StepStatus): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
  };
}

const CONFIRMED_PLAN = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "failed")];
const PENDING_PLAN = [step(0, "MERGE", "pending")];

function stubNetwork(network: string): void {
  const stub: () => unknown = () => ({ network });
  spyOn(navigation, "useParams").mockImplementation(stub as typeof navigation.useParams);
}

function renderBoundary(digest?: string): void {
  const error = Object.assign(new Error("boom"), { digest });
  render(<NetworkError error={error} reset={() => {}} />);
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  spyOn(console, "error").mockImplementation(() => {});
  stubNetwork("testnet");
});

afterEach(() => {
  (navigation.useParams as unknown as { mockRestore: () => void }).mockRestore();
});

test("a failed step after a confirmed one never claims that nothing was submitted", () => {
  useDemolishStore.setState({
    phase: "STEP_FAILED",
    executionPlan: CONFIRMED_PLAN,
    sourceAddress: "GSOURCEPLACEHOLDER",
  });
  const { container } = render(
    <NetworkError error={Object.assign(new Error("boom"), {})} reset={() => {}} />
  );

  expect(container.textContent).not.toContain("no transaction was submitted");
  expect(container.textContent).not.toContain("funds are safe");
  expect(container.textContent).toContain("may already be confirmed");
});

const PRE_SIGNING: DemolishPhase[] = ["IDLE", "ANALYZING", "PREFLIGHT_COMPLETE"];
const LATER: DemolishPhase[] = [
  "STEP_EXECUTING",
  "STEP_CONFIRMED",
  "STEP_FAILED",
  "COMPLETE",
  "SIGNER_SETUP",
  "ABORTED",
];

test.each(PRE_SIGNING)("%s with nothing confirmed says nothing was signed or sent", (phase) => {
  useDemolishStore.setState({ phase, executionPlan: PENDING_PLAN });
  renderBoundary();

  expect(screen.getByText(/Nothing has been signed or sent/)).toBeTruthy();
  expect(screen.queryByText(/may already be confirmed/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Resume the close" })).toBeNull();
});

test.each(LATER)("%s offers resume and explorer instead of reassurance", (phase) => {
  useDemolishStore.setState({
    phase,
    executionPlan: PENDING_PLAN,
    sourceAddress: "GSOURCEPLACEHOLDER",
  });
  renderBoundary();

  expect(screen.getByText(/may already be confirmed/)).toBeTruthy();
  expect(screen.queryByText(/Nothing has been signed or sent/)).toBeNull();
  expect(screen.getByRole("link", { name: "Resume the close" }).getAttribute("href")).toBe(
    "/testnet"
  );
  expect(screen.getByRole("link", { name: /View the account/ }).getAttribute("href")).toBe(
    "https://stellar.expert/explorer/testnet/account/GSOURCEPLACEHOLDER"
  );
});

test("a confirmed step in a pre-signing phase still may have been sent", () => {
  useDemolishStore.setState({ phase: "PREFLIGHT_COMPLETE", executionPlan: CONFIRMED_PLAN });
  renderBoundary();

  expect(screen.getByText(/may already be confirmed/)).toBeTruthy();
});

test("the explorer link is omitted when the store has been wiped", () => {
  useDemolishStore.setState({ phase: "STEP_FAILED", executionPlan: [], sourceAddress: null });
  renderBoundary();

  expect(screen.queryByRole("link", { name: /View the account/ })).toBeNull();
});

test.each(["mainnet", "testnet"])("Go home keeps the %s network", (network) => {
  (navigation.useParams as unknown as { mockRestore: () => void }).mockRestore();
  stubNetwork(network);
  renderBoundary();

  expect(screen.getByRole("link", { name: /Go home/ }).getAttribute("href")).toBe(`/${network}`);
});

test("the reference is readable and can be copied", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  renderBoundary("digest-123");

  const ref = screen.getByText(/ref: digest-123/);
  expect(ref.className).toContain("text-white/60");
  fireEvent.click(screen.getByRole("button", { name: "Copy error reference" }));
  await waitFor(() => expect(copied).toBe("digest-123"));
  expect(await screen.findByText("Copied")).toBeTruthy();
});
