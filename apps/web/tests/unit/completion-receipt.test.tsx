import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import CompletionReceipt from "@/components/complete/CompletionReceipt";
import { useDemolishStore } from "@/store/demolish";
import * as history from "@/lib/session/history";
import * as recovery from "@/lib/session/recovery";
import type { ReceiptRecord } from "@/types/history";
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

/** Renders the receipt and lets its save attempt settle. */
async function show(network: "testnet" | "mainnet" = "testnet") {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CompletionReceipt network={network} />);
  });
  return result;
}

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

test("a partial close shows the incomplete banner with a resume link and no success claim", async () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")]);
  const { container } = await show();

  expect(screen.queryByText("Account successfully merged")).toBeNull();
  expect(container.textContent).not.toContain("removed from the Stellar ledger");
  expect(container.textContent).not.toContain("Account merged");
  // The banner is the status that holds the heading; each copy button has one of its own.
  const banner = screen
    .getAllByRole("status")
    .find((s) => s.contains(screen.getByRole("heading", { level: 1 })));
  expect(banner?.textContent).toContain("1 of 2 transactions confirmed");
  expect(banner?.textContent).toContain("The account still exists");
  expect(screen.getByRole("link", { name: "Resume" }).getAttribute("href")).toBe("/testnet");
  await waitFor(() => expect(document.title).toBe("Close incomplete | LumenWipe"));
});

test("a partial close saves an incomplete record and keeps the saved session", async () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")]);
  render(<CompletionReceipt network="testnet" />);
  await screen.findByText(/Receipt saved to this browser/);

  expect(saveSpy).toHaveBeenCalledTimes(1);
  const record = saveSpy.mock.calls[0][0] as ReceiptRecord;
  expect(record.outcome).toBe("incomplete");
  expect(record.id).toBe("session-1");
  expect(record.transactions.map((t) => t.txHash)).toEqual(["hash0"]);
  await new Promise((r) => setTimeout(r, 20));
  expect(cleanupSpy).not.toHaveBeenCalled();
});

test("a close with only non-merge steps confirmed is incomplete", async () => {
  seed([step(0, "REMOVE_TRUSTLINES", "confirmed"), step(1, "CLOSE_ACCOUNT", "failed")]);
  await show("mainnet");

  expect(screen.queryByText("Account successfully merged")).toBeNull();
  expect(screen.getByRole("link", { name: "Resume" }).getAttribute("href")).toBe("/mainnet");
});

test("a confirmed merge shows the success banner and saves then cleans up", async () => {
  seed([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "confirmed")]);
  render(<CompletionReceipt network="testnet" />);

  expect(screen.getByText("Account successfully merged")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
  await waitFor(() => expect(document.title).toBe("Account closed | LumenWipe"));
  await waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("session-1"));
  expect(saveSpy).toHaveBeenCalledTimes(1);
});

test("a fused confirmed close-account step shows the success banner", async () => {
  seed([step(0, "CLOSE_ACCOUNT", "confirmed")]);
  await show();

  expect(screen.getByText("Account successfully merged")).toBeTruthy();
});

test("the explorer link on an unfinished close spans the receipt", async () => {
  seed([step(0, "REMOVE_TRUSTLINES", "confirmed"), step(1, "CLOSE_ACCOUNT", "failed")]);
  await show();

  const link = screen.getByRole("link", { name: /View the account on Stellar Expert/ });
  expect(link.className.split(" ")).toContain("w-full");
});

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the saved notice renders only after the write resolved", async () => {
  const write = deferred();
  saveSpy.mockReturnValue(write.promise);
  seed([step(0, "MERGE", "confirmed")]);
  const { container } = render(<CompletionReceipt network="testnet" />);

  expect(screen.getByText("Saving the receipt…")).toBeTruthy();
  expect(container.textContent).not.toContain("Receipt saved");
  expect(cleanupSpy).not.toHaveBeenCalled();

  await act(async () => write.resolve());
  expect(screen.getByText(/Receipt saved to this browser/)).toBeTruthy();
  await waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("session-1"));
});

test("a rejected write shows the failure and a download, never the saved notice", async () => {
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  saveSpy.mockRejectedValue(new Error("QuotaExceededError"));
  seed([step(0, "MERGE", "confirmed")]);
  const { container } = render(<CompletionReceipt network="testnet" />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("could not keep the receipt");
  expect(screen.getByRole("button", { name: /Download receipt/ })).toBeTruthy();
  expect(container.textContent).not.toContain("Receipt saved");
  // The close finished, so its session is cleaned up once the attempt settled.
  await waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith("session-1"));
  consoleSpy.mockRestore();
});

test("a confirmed merge with a transaction still in flight keeps the saved session", async () => {
  seed([step(0, "MERGE", "confirmed")]);
  useDemolishStore.setState({
    unconfirmedSubmission: { hash: "h", covers: ["MERGE"], validUntil: 0 } as never,
  });
  render(<CompletionReceipt network="testnet" />);
  await screen.findByText(/Receipt saved to this browser/);
  await new Promise((r) => setTimeout(r, 20));

  expect(cleanupSpy).not.toHaveBeenCalled();
});

test("a close without a session id is still saved, under an id of its own", async () => {
  seed([step(0, "MERGE", "confirmed")]);
  useDemolishStore.setState({ sessionId: null });
  render(<CompletionReceipt network="testnet" />);
  await screen.findByText(/Receipt saved to this browser/);

  const record = saveSpy.mock.calls[0][0] as ReceiptRecord;
  expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(record.outcome).toBe("closed");
  expect(cleanupSpy).not.toHaveBeenCalled();
});

test("a close with nothing confirmed writes no record", async () => {
  seed([step(0, "MERGE", "failed")]);
  render(<CompletionReceipt network="testnet" />);
  await new Promise((r) => setTimeout(r, 20));

  expect(saveSpy).not.toHaveBeenCalled();
  expect(cleanupSpy).not.toHaveBeenCalled();
});

test("the record carries no transaction envelope, key or signer", async () => {
  const xdr = "AAAAAgAAAABENVELOPEXDR";
  const plan = [step(0, "NORMALIZE_SIGNERS", "confirmed"), step(1, "MERGE", "confirmed")].map(
    (s) => ({ ...s, txXdr: xdr })
  );
  seed(plan);
  render(<CompletionReceipt network="testnet" />);
  await screen.findByText(/Receipt saved to this browser/);

  const json = JSON.stringify(saveSpy.mock.calls[0][0]);
  expect(json).not.toContain(xdr);
  expect(json).not.toContain("txXdr");
  expect(json).not.toMatch(/"S[A-Z2-7]{55}"/);
});
