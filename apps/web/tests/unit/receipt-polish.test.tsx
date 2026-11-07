import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as navigation from "next/navigation";
import ReceiptPage from "@/app/[network]/receipt/[id]/page";
import ReceiptActions from "@/components/receipt/ReceiptActions";
import ReceiptGroupRow from "@/components/receipt/ReceiptGroupRow";
import { ExplorerLink } from "@/components/ui/explorer-link";
import { IdentifierDisplay } from "@/components/ui/identifier-display";
import { saveHistory } from "@/lib/session/history";
import type { ReceiptGroup, ReceiptRecord } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const HASH = "a".repeat(58) + "beef01";

beforeEach(() => {
  installIndexedDb();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  removeIndexedDb();
});

const GROUP: ReceiptGroup = {
  type: "NORMALIZE_SIGNERS",
  title: "Signers removed",
  summary: "2 extra signers, thresholds reset",
  items: [
    { text: "GABCDEFG…12345678", detail: "weight 1", mono: true },
    { text: "GHIJKLMN…87654321", detail: "weight 2", mono: true },
  ],
  note: "Thresholds were reset.",
};

function record(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "r-1",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    memo: { text: null, type: null },
    transactions: [{ txHash: HASH, label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] }],
    groups: [GROUP],
    feeLumens: "0.0000100",
    receivedLumens: "10.0000000",
    ...over,
  };
}

/** The text an element shows on screen: without its copies that exist only on paper. */
function onScreen(el: Element | null): string {
  const clone = el?.cloneNode(true) as Element | undefined;
  clone?.querySelectorAll("[data-print-only]").forEach((node) => node.remove());
  return clone?.textContent ?? "";
}

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

async function openReceipt(): Promise<void> {
  await act(async () => {
    render(<ReceiptPage params={settled({ network: "testnet" as const, id: "r-1" })} />);
  });
  await waitFor(() => expect(screen.queryAllByText("Loading the receipt…")).toHaveLength(0));
}

test("an identifier shows short by default, reveals in full and copies the whole value", async () => {
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  render(<IdentifierDisplay value={HASH} kind="hash" label="merge hash" />);

  const toggle = screen.getByRole("button", { name: "Show full merge hash" });
  const shown = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  expect(onScreen(shown)).toBe("aaaaaa…beef01");
  // On paper the whole hash is printed, since nothing can be revealed there.
  expect(shown?.querySelector("[data-print-only]")?.textContent).toBe(HASH);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.tagName).toBe("BUTTON");
  expect(toggle.getAttribute("type")).toBe("button");

  fireEvent.click(toggle);
  expect(shown?.textContent).toBe(HASH);
  expect(shown?.querySelectorAll("[data-print-only]")).toHaveLength(0);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Shorten merge hash");
  expect(toggle.className).toContain("print:hidden");

  fireEvent.click(toggle);
  expect(onScreen(shown)).toBe("aaaaaa…beef01");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy merge hash" }));
  });
  expect(writeText).toHaveBeenCalledWith(HASH);
  expect(screen.getByRole("status").textContent).toBe("Copied the merge hash.");
});

test("an address is shortened its own way, and a value too short to shorten has no toggle", () => {
  render(<IdentifierDisplay value={DEST} kind="address" label="destination address" />);
  expect(screen.getByText("GDESTINA…00000000")).toBeTruthy();
  cleanup();

  render(<IdentifierDisplay value="abc" kind="hash" label="hash" />);
  expect(screen.getByText("abc")).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /Show full/ })).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Copy hash" })).toBeTruthy();
});

test("an explorer link names what it opens and that it opens a new tab", () => {
  render(
    <ExplorerLink href="https://stellar.expert/x" target="transaction aaaaaa…beef01">
      Stellar Expert
    </ExplorerLink>
  );
  const link = screen.getByRole("link", {
    name: "Stellar Expert - transaction aaaaaa…beef01, opens in a new tab",
  });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("a group is collapsed behind its count and opens and closes from its button", () => {
  render(<ReceiptGroupRow group={GROUP} />);
  const toggle = screen.getByRole("button", { name: /Signers removed · 2/ });
  const details = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  expect(toggle.tagName).toBe("BUTTON");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(details?.classList.contains("hidden")).toBe(true);
  expect(details?.textContent).toContain("GABCDEFG…12345678 · weight 1");

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(details?.classList.contains("hidden")).toBe(false);

  fireEvent.click(toggle);
  expect(details?.classList.contains("hidden")).toBe(true);
});

test("the actions have one solid primary, stack below 640px and name their targets", () => {
  render(<ReceiptActions network="testnet" destinationAddress={DEST} />);
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(3);

  const primary = screen.getByRole("link", {
    name: "View destination on Stellar Expert - account GDESTINA…00000000, opens in a new tab",
  });
  expect(primary.getAttribute("href")).toBe(
    `https://stellar.expert/explorer/testnet/account/${DEST}`
  );
  expect(links.filter((l) => l.className.includes("bg-accent"))).toEqual([primary]);

  const another = screen.getByRole("link", { name: "Close another account" });
  expect(another.getAttribute("href")).toBe("/testnet");
  expect(another.className).toContain("border");

  expect(
    screen.getByRole("link", {
      name: "View on StellarView - account GDESTINA…00000000, opens in a new tab",
    })
  ).toBeTruthy();

  const row = primary.parentElement as HTMLElement;
  expect(row.className.split(" ")).toEqual(
    expect.arrayContaining(["flex", "flex-col", "sm:flex-row"])
  );
});

test("a reopened closed receipt focuses its h1 inside a status banner and retitles the page", async () => {
  await saveHistory(record());
  await openReceipt();

  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1.textContent).toBe("Account successfully merged");
  expect(document.activeElement).toBe(h1);
  expect(screen.getAllByRole("status").some((s) => s.contains(h1))).toBe(true);
  expect(document.title).toBe("Account closed | LumenWipe");
});

test("the receipt shows each hash and address one way, with no bare initials for explorers", async () => {
  await saveHistory(record({ outcome: "incomplete", groups: [] }));
  await openReceipt();

  expect(screen.getByRole("button", { name: "Show full hash of Merge" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show full source account" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show full destination address" })).toBeTruthy();
  for (const link of screen.getAllByRole("link")) {
    expect(link.textContent?.trim()).not.toMatch(/^(SE|SV)$/);
  }
  const ledger = screen.getByText("Merge").closest("div") as HTMLElement;
  expect(within(ledger).getAllByRole("link", { name: /opens in a new tab$/ })).toHaveLength(2);
});
