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
