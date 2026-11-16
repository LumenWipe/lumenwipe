import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import * as navigation from "next/navigation";
import { StrictMode } from "react";
import ReceiptPage from "@/app/[network]/receipt/[id]/page";
import ReceiptHeadline from "@/components/receipt/ReceiptHeadline";
import { useReceivedLumens } from "@/hooks/useReceivedLumens";
import { getHistory, saveHistory } from "@/lib/session/history";
import type { ReceiptRecord } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const MERGE_HASH = "a".repeat(64);
const OFFERS_HASH = "c".repeat(64);
const UNAVAILABLE = "Amount not available - check the transaction on the explorer";

let fetchSpy: ReturnType<typeof spyOn>;
let consoleSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  installIndexedDb();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  cleanup();
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
    memo: { text: null, type: null },
    transactions: [
      {
        txHash: OFFERS_HASH,
        label: "Cancel offers",
        stepTypes: ["CANCEL_OFFERS"],
        stepTitles: ["Cancel offers"],
      },
      { txHash: MERGE_HASH, label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] },
    ],
    groups: [
      {
        type: "CANCEL_OFFERS",
        title: "Offers cancelled",
        summary: "1 open offer",
        items: [{ text: "10 USDC → XLM" }],
      },
    ],
    feeLumens: "0.0000200",
    receivedLumens: null,
    ...over,
  };
}

function deliveredAnswer(amountStroops = "123400000") {
  return Response.json({
    destination: DEST,
    entries: [{ hash: MERGE_HASH, status: "delivered", ledger: 9, amountStroops }],
    totalStroops: amountStroops,
  });
}

function unavailableAnswer() {
  return Response.json({
    destination: DEST,
    entries: [{ hash: MERGE_HASH, status: "unavailable", reason: "not_found" }],
  });
}

function failedAnswer() {
  return Response.json(
    { error: { code: "service_unavailable", message: "The network could not be read. Retry." } },
    { status: 503 }
  );
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

test("the amount is read from the merge's result, shown and kept in the record", async () => {
  fetchSpy.mockImplementation(async () => deliveredAnswer());
  await saveHistory(record());
  await openReceipt();

  await screen.findByText("Received 12.34 XLM");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetchSpy.mock.calls[0][0]), "https://www.lumenwipe.com");
  expect(url.pathname).toBe("/api/v1/testnet/close/delivered");
  expect([...url.searchParams.keys()].sort()).toEqual(["destination", "hashes"]);
  expect(url.searchParams.get("destination")).toBe(DEST);
  // Only the merge delivers to the destination: the offers transaction is not asked about.
  expect(url.searchParams.get("hashes")).toBe(MERGE_HASH);

  await waitFor(async () => expect((await getHistory("r-1"))?.receivedLumens).toBe("12.3400000"));
});

test("a reopened receipt shows the kept amount and asks nothing", async () => {
  fetchSpy.mockImplementation(async () => deliveredAnswer());
  await saveHistory(record());
  await openReceipt();
  await waitFor(async () => expect((await getHistory("r-1"))?.receivedLumens).toBe("12.3400000"));
  cleanup();

  // A refresh: the node may no longer hold the transaction, and is not asked again.
  fetchSpy.mockImplementation(async () => unavailableAnswer());
  await openReceipt();
  expect(screen.getByText("Received 12.34 XLM")).toBeTruthy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("an unavailable amount says so with the hash, never zero, and is not kept", async () => {
  fetchSpy.mockImplementation(async () => unavailableAnswer());
  await saveHistory(record());
  await openReceipt();

  await screen.findByText(UNAVAILABLE);
  const link = screen.getByRole("link", { name: new RegExp(MERGE_HASH) });
  expect(link.getAttribute("href")).toBe(
    `https://stellar.expert/explorer/testnet/tx/${MERGE_HASH}`
  );
  expect(document.body.textContent).not.toMatch(/Received 0/);
  expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(0);
  // The rest of the receipt is all there.
  expect(screen.getByText("Offers cancelled")).toBeTruthy();
  expect((await getHistory("r-1"))?.receivedLumens).toBe(null);
});

test("a failed lookup says so, keeps the receipt and asks again only on Try again", async () => {
  fetchSpy.mockImplementation(async () => failedAnswer());
  await saveHistory(record());
  await openReceipt();

  await screen.findByText(UNAVAILABLE);
  expect(screen.getByText("Offers cancelled")).toBeTruthy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  fetchSpy.mockImplementation(async () => deliveredAnswer("5000000000"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  await screen.findByText("Received 500.00 XLM");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  await waitFor(async () => expect((await getHistory("r-1"))?.receivedLumens).toBe("500.0000000"));
});

test("the headline names the full destination and an exchange close's relay", async () => {
  await saveHistory(record({ mediatorRequired: true, receivedLumens: "1.0000000" }));
  await openReceipt();

  expect(screen.getByText("Received 1.00 XLM")).toBeTruthy();
  expect(screen.getByText(DEST)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy destination address" })).toBeTruthy();
  expect(screen.getByText("via relay account")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("an incomplete receipt has no amount and asks nothing", async () => {
  await saveHistory(record({ outcome: "incomplete" }));
  await openReceipt();

  expect(document.body.textContent).not.toMatch(/Received|Amount not available/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a closed receipt with no merge hash to ask about reads not recorded", async () => {
  await saveHistory(
    record({
      transactions: [{ txHash: "x", label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] }],
    })
  );
  await openReceipt();

  expect(screen.getByText("Amount received: not recorded")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("re-rendering never asks again, even with a new copy of the record", async () => {
  fetchSpy.mockImplementation(async () => failedAnswer());
  const { result, rerender } = renderHook(
    ({ r }: { r: ReceiptRecord }) => useReceivedLumens(r, { enabled: true, persist: false }),
    { initialProps: { r: record() } }
  );
  await waitFor(() => expect(result.current.received.state).toBe("failed"));
  for (let i = 0; i < 3; i++) {
    await act(async () => rerender({ r: record() }));
  }
  expect(result.current.received.state).toBe("failed");
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  fetchSpy.mockImplementation(async () => deliveredAnswer());
  await act(async () => result.current.retry());
  await waitFor(() => expect(result.current.received.state).toBe("recorded"));
  await act(async () => rerender({ r: record() }));
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("neither a change of options nor a strict double effect asks again", async () => {
  fetchSpy.mockImplementation(async () => failedAnswer());
  const { result, rerender } = renderHook(
    ({ enabled, persist }: { enabled: boolean; persist: boolean }) =>
      useReceivedLumens(record(), { enabled, persist }),
    { initialProps: { enabled: true, persist: false }, wrapper: StrictMode }
  );
  await waitFor(() => expect(result.current.received.state).toBe("failed"));
  await act(async () => rerender({ enabled: true, persist: true }));
  await act(async () => rerender({ enabled: false, persist: true }));
  await act(async () => rerender({ enabled: true, persist: true }));
  expect(result.current.received.state).toBe("failed");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("nothing is asked until the lookup is enabled, and nothing kept unless asked to", async () => {
  fetchSpy.mockImplementation(async () => deliveredAnswer());
  await saveHistory(record());
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => useReceivedLumens(record(), { enabled, persist: false }),
    { initialProps: { enabled: false } }
  );
  expect(result.current.received.state).toBe("loading");
  expect(fetchSpy).not.toHaveBeenCalled();

  await act(async () => rerender({ enabled: true }));
  await waitFor(() =>
    expect(result.current.received).toEqual({ state: "recorded", lumens: "12.3400000" })
  );
  expect((await getHistory("r-1"))?.receivedLumens).toBe(null);
  expect(consoleSpy).not.toHaveBeenCalled();
});

test("a record naming no known network gets no explorer link, only its hashes", () => {
  for (const network of ["/evil.example", "undefined", ""]) {
    render(
      <ReceiptHeadline
        record={record({ network: network as never })}
        received={{ state: "unavailable", hashes: [MERGE_HASH] }}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
    expect(screen.getByText(MERGE_HASH)).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("undefined/");
    cleanup();
  }

  render(
    <ReceiptHeadline
      record={record()}
      received={{ state: "unavailable", hashes: [MERGE_HASH] }}
      onRetry={() => {}}
    />
  );
  expect(screen.getByRole("link", { name: new RegExp(MERGE_HASH) }).getAttribute("href")).toBe(
    `https://stellar.expert/explorer/testnet/tx/${MERGE_HASH}`
  );
  expect(fetchSpy).not.toHaveBeenCalled();
});
