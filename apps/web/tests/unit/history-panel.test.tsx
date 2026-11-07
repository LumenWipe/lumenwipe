import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import HistoryPanel from "@/components/history/HistoryPanel";
import * as history from "@/lib/session/history";
import type { ReceiptRecord } from "@/types/history";

afterEach(() => {
  mock.restore();
});

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Merge history</button>
      {open && <HistoryPanel onClose={() => setOpen(false)} />}
    </>
  );
}

async function openPanel(entries: ReceiptRecord[] = []): Promise<HTMLElement> {
  spyOn(history, "listHistory").mockResolvedValue(entries);
  render(<Host />);
  const trigger = screen.getByRole("button", { name: "Merge history" });
  trigger.focus();
  await act(async () => {
    fireEvent.click(trigger);
  });
  return trigger;
}

test("HistoryPanel › is a named, described dialog with focus on its close button", async () => {
  await openPanel();
  const dialog = screen.getByRole("dialog", { name: "Merge history" });
  expect(
    document.getElementById(dialog.getAttribute("aria-describedby") as string)?.textContent
  ).toBe("History is stored locally in your browser and never leaves your device.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
});

test("HistoryPanel › Escape closes it and focus returns to the trigger", async () => {
  const trigger = await openPanel();
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("HistoryPanel › the scrim closes it", async () => {
  await openPanel();
  fireEvent.click(document.querySelector("[data-dialog-scrim]") as Element);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("HistoryPanel › the delete control has an accessible name", async () => {
  await openPanel([
    {
      id: "1",
      network: "testnet",
      sourceAddress: "GSOURCE",
      destinationAddress: "GDESTINATION",
      version: 2,
      outcome: "closed",
      completedAt: "2026-11-01T00:00:00.000Z",
      memo: null,
      transactions: [],
      groups: null,
      feeLumens: "0",
      receivedLumens: null,
      mediatorRequired: false,
    },
  ]);
  expect(screen.getByRole("button", { name: "Delete entry" })).toBeTruthy();
});

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";

function entry(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: 2,
    id: "r-1",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-01T12:00:00.000Z",
    memo: null,
    transactions: [{ txHash: "h1", label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] }],
    groups: null,
    feeLumens: "0.0000100",
    receivedLumens: null,
    ...over,
  };
}

async function openWith(read: () => Promise<ReceiptRecord[]>): Promise<void> {
  spyOn(history, "listHistory").mockImplementation(read);
  render(<Host />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Merge history" }));
  });
}

test("HistoryPanel › a rejected read shows an error with a retry, never the empty state", async () => {
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  await openWith(async () => {
    calls += 1;
    if (calls === 1) throw new Error("blocked");
    return [entry()];
  });

  expect(screen.getByRole("alert").textContent).toContain("could not be read in this browser");
  expect(screen.queryAllByText("No merges recorded yet.")).toHaveLength(0);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(calls).toBe(2);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(screen.getByRole("link", { name: /Open receipt/ })).toBeTruthy();
  consoleSpy.mockRestore();
});

test("HistoryPanel › only a successful read with no entries shows the empty state", async () => {
  await openWith(async () => []);
  expect(screen.getByText("No merges recorded yet.")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("HistoryPanel › entries show the amount received or that it was not recorded, and link to their receipt", async () => {
  await openWith(async () => [
    entry({ id: "with amount", receivedLumens: "99.5" }),
    entry({ id: "without", outcome: "incomplete" }),
  ]);

  expect(screen.queryAllByText("No merges recorded yet.")).toHaveLength(0);
  expect(screen.getByText("99.50 XLM")).toBeTruthy();
  expect(screen.getByText("not recorded")).toBeTruthy();
  expect(screen.getByText(/not finished/)).toBeTruthy();
  const links = screen.getAllByRole("link", { name: /Open receipt/ });
  expect(links.map((l) => l.getAttribute("href"))).toEqual([
    "/testnet/receipt/with%20amount",
    "/testnet/receipt/without",
  ]);
  expect(screen.getAllByText("GSOURCE0…00000000")).toHaveLength(2);
  // Every entry can be copied and downloaded, each action named for its own entry.
  for (const action of ["Copy summary", "Download JSON", "Download CSV"]) {
    expect(screen.getAllByRole("button", { name: new RegExp(`^${action} of `) })).toHaveLength(2);
  }
});

test("HistoryPanel › opening a receipt closes the drawer", async () => {
  await openWith(async () => [entry()]);
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: /Open receipt/ }));
  });
  expect(screen.queryAllByRole("dialog")).toHaveLength(0);
});

async function confirmDelete(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  });
}

test("HistoryPanel › a rejected delete keeps the entry and says so", async () => {
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  spyOn(history, "deleteHistoryEntry").mockRejectedValue(new Error("blocked"));
  await openWith(async () => [entry()]);
  await confirmDelete();

  expect(screen.getByRole("alert").textContent).toContain("could not be deleted");
  expect(screen.getByRole("link", { name: /Open receipt/ })).toBeTruthy();
  consoleSpy.mockRestore();
});

test("HistoryPanel › a delete that succeeds removes the entry", async () => {
  const remove = spyOn(history, "deleteHistoryEntry").mockResolvedValue(undefined);
  await openWith(async () => [entry()]);
  await confirmDelete();

  expect(remove).toHaveBeenCalledWith("r-1");
  expect(screen.queryAllByRole("link", { name: /Open receipt/ })).toHaveLength(0);
  expect(screen.getByText("No merges recorded yet.")).toBeTruthy();
});
