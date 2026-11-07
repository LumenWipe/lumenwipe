import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as navigation from "next/navigation";
import ReceiptPage from "@/app/[network]/receipt/[id]/page";
import { saveHistory } from "@/lib/session/history";
import type { ReceiptRecord } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const WEB = join(import.meta.dir, "..", "..");
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const HASHES = ["a".repeat(64), "b".repeat(64)];

beforeEach(() => {
  installIndexedDb();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
});

afterEach(() => {
  mock.restore();
  removeIndexedDb();
});

function record(): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "r-1",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    memo: { text: "4242", type: "id" },
    transactions: HASHES.map((txHash, i) => ({
      txHash,
      label: i === 0 ? "Cancel offers" : "Merge",
      stepTypes: [i === 0 ? "CANCEL_OFFERS" : "MERGE"],
      stepTitles: [],
    })),
    groups: [
      {
        type: "HANDLE_ASSETS",
        title: "Assets handled",
        summary: "1 asset with a balance",
        items: [{ text: "USDC → swapped to XLM" }],
      },
    ],
    feeLumens: "0.0000200",
    receivedLumens: "10.0000000",
  };
}

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

async function openReceipt(): Promise<HTMLElement> {
  await saveHistory(record());
  await act(async () => {
    render(<ReceiptPage params={settled({ network: "testnet" as const, id: "r-1" })} />);
  });
  await waitFor(() => expect(screen.queryAllByText("Loading the receipt…")).toHaveLength(0));
  return document.querySelector("[data-receipt]") as HTMLElement;
}

/** What a printed page holds of an element: its print-only copies, and none of its print:hidden. */
function onPaper(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[class*="print:hidden"]').forEach((node) => node.remove());
  return clone.textContent ?? "";
}

test("the receipt route prints from its own action", async () => {
  // This DOM has no print dialog: stand one in for the click.
  const print = mock(() => {});
  Object.assign(window, { print });
  await openReceipt();
  const button = screen.getByRole("button", { name: "Print or save as PDF" });
  expect(button.closest('[class*="print:hidden"]')).toBeTruthy();
  fireEvent.click(button);
  expect(print).toHaveBeenCalledTimes(1);
  delete (window as { print?: unknown }).print;
});

test("on paper every hash is whole with its explorer URL, and the groups are open", async () => {
  const receipt = await openReceipt();
  const paper = onPaper(receipt);
  for (const hash of HASHES) {
    expect(paper).toContain(hash);
    expect(paper).toContain(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(paper).not.toContain(`${hash.slice(0, 6)}…`);
  }
  expect(paper).toContain(SOURCE);
  expect(paper).toContain(DEST);
  expect(paper).toContain("Assets handled");
  expect(paper).toContain("USDC → swapped to XLM");
  const details = screen.getByText("USDC → swapped to XLM").closest("[id]") as HTMLElement;
  expect(details.className).toContain("hidden print:block");
  // Nothing interactive is left on paper.
  const printed = receipt.cloneNode(true) as Element;
  printed.querySelectorAll('[class*="print:hidden"]').forEach((node) => node.remove());
  expect(printed.querySelectorAll("a[href^='/'], [role='button']")).toHaveLength(0);
});

test("the page chrome and the print rules are in place", () => {
  expect(readFileSync(join(WEB, "components/layout/NavBar.tsx"), "utf8")).toMatch(
    /<header className="[^"]*print:hidden/
  );
  const layout = readFileSync(join(WEB, "app/[network]/layout.tsx"), "utf8");
  expect(layout).toMatch(/<div className="print:hidden">\s*<NetworkStats \/>/);
  expect(layout).toMatch(/absolute inset-0 z-0 print:hidden/);
  const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
  const print = css.slice(css.indexOf("@media print"));
  for (const rule of ["[data-receipt] button", "[data-sonner-toaster]", "[data-print-only]"]) {
    expect(print).toContain(rule);
  }
  expect(print).toContain("color: black !important");
});
