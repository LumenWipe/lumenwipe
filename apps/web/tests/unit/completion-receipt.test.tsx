import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import CompletionReceipt from "@/components/complete/CompletionReceipt";
import { useDemolishStore } from "@/store/demolish";
import * as history from "@/lib/session/history";
import * as recovery from "@/lib/session/recovery";
import type { PlannedStep, StepStatus, StepType } from "@/types/plan";

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

let saveSpy: ReturnType<typeof spyOn>;
let cleanupSpy: ReturnType<typeof spyOn>;

function seed(plan: PlannedStep[]): void {
  useDemolishStore.setState({
    executionPlan: plan,
    phase: "STEP_FAILED",
    sessionId: "session-1",
    sourceAddress: "GSOURCEPLACEHOLDER",
    destinationAddress: "GDESTPLACEHOLDER",
  });
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  saveSpy = spyOn(history, "saveHistory").mockResolvedValue(undefined);
  cleanupSpy = spyOn(recovery, "cleanupSession").mockResolvedValue(undefined);
});

afterEach(() => {
  saveSpy.mockRestore();
  cleanupSpy.mockRestore();
});

test("a partial close shows the incomplete banner with a resume link and no success claim", () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")]);
  const { container } = render(<CompletionReceipt network="testnet" />);

  expect(screen.queryByText("Account successfully merged")).toBeNull();
  expect(container.textContent).not.toContain("removed from the Stellar ledger");
  expect(container.textContent).not.toContain("Account merged");
  expect(container.textContent).not.toContain("Receipt saved");
  expect(screen.getByRole("status").textContent).toContain("1 of 2 transactions confirmed");
  expect(screen.getByRole("status").textContent).toContain("The account still exists");
  expect(screen.getByRole("link", { name: "Resume" }).getAttribute("href")).toBe("/testnet");
});

test("a partial close writes no history entry and keeps the saved session", async () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")]);
  render(<CompletionReceipt network="testnet" />);
  await new Promise((r) => setTimeout(r, 20));

  expect(saveSpy).not.toHaveBeenCalled();
  expect(cleanupSpy).not.toHaveBeenCalled();
});

test("a close with only non-merge steps confirmed is incomplete", () => {
  seed([step(0, "REMOVE_TRUSTLINES", "confirmed"), step(1, "CLOSE_ACCOUNT", "failed")]);
  render(<CompletionReceipt network="mainnet" />);

  expect(screen.queryByText("Account successfully merged")).toBeNull();
  expect(screen.getByRole("link", { name: "Resume" }).getAttribute("href")).toBe("/mainnet");
});

test("a confirmed merge shows the success banner and saves then cleans up", async () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "confirmed")]);
  render(<CompletionReceipt network="testnet" />);

  expect(screen.getByText("Account successfully merged")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
  await waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("session-1"));
  expect(saveSpy).toHaveBeenCalledTimes(1);
});

test("a fused confirmed close-account step shows the success banner", () => {
  seed([step(0, "CLOSE_ACCOUNT", "confirmed")]);
  render(<CompletionReceipt network="testnet" />);

  expect(screen.getByText("Account successfully merged")).toBeTruthy();
});
