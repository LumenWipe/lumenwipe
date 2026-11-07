import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as navigation from "next/navigation";
import CompletePage from "@/app/[network]/complete/page";
import ReceiptPage from "@/app/[network]/receipt/[id]/page";
import { saveHistory } from "@/lib/session/history";
import * as history from "@/lib/session/history";
import { useDemolishStore } from "@/store/demolish";
import type { ReceiptRecord } from "@/types/history";
import type { PlannedStep } from "@/types/plan";
import { RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const HASH = "a".repeat(58) + "beef01";

let replace: ReturnType<typeof mock>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  installIndexedDb();
  useDemolishStore.getState().reset();
  replace = mock(() => {});
  const router = { push: () => {}, replace };
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  mock.restore();
  removeIndexedDb();
});

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
    memo: { text: "4242", type: "id" },
    transactions: [{ txHash: HASH, label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] }],
    groups: [
      {
        type: "CANCEL_OFFERS",
        title: "Offers cancelled",
        summary: "1 open offer",
        items: [{ text: "10 USDC → XLM" }],
      },
    ],
    feeLumens: "0.0000100",
    receivedLumens: null,
    ...over,
  };
}

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

async function openReceipt(id: string, network: "testnet" | "mainnet" = "testnet") {
  await act(async () => {
    render(<ReceiptPage params={settled({ network, id })} />);
  });
  if (network === "testnet") await waitForRead();
}

async function waitForRead(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByText("Loading the receipt…")).toHaveLength(0));
}

test("the route renders a stored receipt from this browser alone", async () => {
  await saveHistory(record());
  await openReceipt("r-1");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Account successfully merged");
  expect(screen.getByText("Offers cancelled")).toBeTruthy();
  expect(screen.getByText("10 USDC → XLM")).toBeTruthy();
  expect(screen.getByText("aaaaaa…beef01")).toBeTruthy();
  expect(screen.getByText("4242")).toBeTruthy();
  expect(screen.getByText("2026-11-07 10:30 UTC")).toBeTruthy();
  const se = screen.getAllByRole("link", { name: /SE/ })[0];
  expect(se.getAttribute("href")).toContain(`/tx/${HASH}`);
  expect(screen.getByRole("link", { name: /Merge another account/ })).toBeTruthy();
  expect(document.title).toBe("Account closed | LumenWipe");
});

test("an entry from before this record opens a reduced receipt", async () => {
  const db = await (
    await import("idb")
  ).openDB("lumenwipe", 2, {
    upgrade(d) {
      d.createObjectStore("sessions", { keyPath: "id" });
      d.createObjectStore("history", { keyPath: "id" });
    },
  });
  await db.put("history", {
    id: "old",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    completedAt: "2026-01-02T03:04:05.000Z",
    txReceipts: [{ type: "MERGE", title: "Merge account", txHash: HASH }],
    totalFeeLumens: "0.0000100",
    usedMediator: false,
  });
  db.close();
  await openReceipt("old");

  expect(screen.getByText("Merge account")).toBeTruthy();
  expect(screen.getByText(/this receipt was saved before the details of each step/)).toBeTruthy();
  // Memo and amount were not recorded then.
  expect(screen.getAllByText("Not recorded").length).toBe(2);
});

test("an incomplete receipt never reads as closed", async () => {
  await saveHistory(record({ outcome: "incomplete", groups: [] }));
  const container = document.body;
  await openReceipt("r-1");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Close not finished");
  expect(container.textContent).not.toContain("successfully merged");
  expect(screen.queryAllByRole("link", { name: /Merge another account/ })).toHaveLength(0);
  expect(document.title).toBe("Close incomplete | LumenWipe");
});

test("an unknown id explains that receipts stay on the device that made them", async () => {
  await openReceipt("nope");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Receipt not found in this browser"
  );
  expect(screen.getByText(/stored only in the browser that made them/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to the start" }).getAttribute("href")).toBe(
    "/testnet"
  );
});

test("a failed read is not reported as a missing receipt, and can be retried", async () => {
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  const read = spyOn(history, "getHistory").mockRejectedValueOnce(new Error("blocked"));
  await saveHistory(record());
  await openReceipt("r-1");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "The receipt could not be read"
  );
  expect(screen.queryAllByText(/Receipt not found/)).toHaveLength(0);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  await waitForRead();
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Account successfully merged");
  consoleSpy.mockRestore();
});

test("a receipt opened under the other network moves to its own", async () => {
  await saveHistory(record());
  await openReceipt("r-1", "mainnet");

  await waitFor(() => expect(replace).toHaveBeenCalled());
  expect(replace).toHaveBeenCalledWith("/testnet/receipt/r-1");
  expect(screen.queryAllByText("Offers cancelled")).toHaveLength(0);
});

function confirmedMerge(): PlannedStep {
  return {
    index: 0,
    type: "MERGE",
    title: "Merge",
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    actualFeeLumens: "0.0000100",
    txXdr: null,
    status: "confirmed",
    txHash: HASH,
    error: null,
  };
}

test("a finished close moves to its saved receipt once the write resolved", async () => {
  useDemolishStore.setState({
    phase: "COMPLETE",
    executionPlan: [confirmedMerge()],
    sessionId: "s-9",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
  });
  await act(async () => {
    render(<CompletePage params={settled({ network: "testnet" as const })} />);
  });

  await waitFor(() => expect(replace).toHaveBeenCalledWith("/testnet/receipt/s-9"));
  expect((await history.getHistory("s-9"))?.outcome).toBe("closed");
});

test("a finished close whose save failed stays on the page with its download", async () => {
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  spyOn(history, "saveHistory").mockRejectedValue(new Error("blocked"));
  useDemolishStore.setState({
    phase: "COMPLETE",
    executionPlan: [confirmedMerge()],
    sessionId: "s-9",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
  });
  await act(async () => {
    render(<CompletePage params={settled({ network: "testnet" as const })} />);
  });

  await screen.findByRole("button", { name: /Download receipt/ });
  expect(replace).not.toHaveBeenCalled();
  consoleSpy.mockRestore();
});

test("the close page with no close in this tab explains instead of redirecting", async () => {
  await act(async () => {
    render(<CompletePage params={settled({ network: "testnet" as const })} />);
  });

  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("No close to show here");
  expect(screen.getByText(/open it from the history icon/)).toBeTruthy();
});

test("a stored record naming an unknown network is not shown or followed", async () => {
  await saveHistory(record({ network: "/evil.example" as never }));
  await openReceipt("r-1");

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Receipt not found in this browser"
  );
  expect(replace).not.toHaveBeenCalled();
});

test("explorer links encode what the record holds", async () => {
  await saveHistory(
    record({
      transactions: [
        { txHash: "a/../b", label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] },
      ],
    })
  );
  await openReceipt("r-1");

  const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href") ?? "");
  expect(hrefs).toContain("https://stellar.expert/explorer/testnet/tx/a%2F..%2Fb");
  expect(hrefs.some((h) => h.includes("/tx/a/../b"))).toBe(false);
});
