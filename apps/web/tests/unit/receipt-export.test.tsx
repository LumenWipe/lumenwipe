import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReceiptExportActions from "@/components/receipt/ReceiptExportActions";
import { receiptFileName } from "@/lib/receipt/download";
import {
  CSV_COLUMNS,
  csvCell,
  NOT_RECORDED,
  receiptCsv,
  receiptExport,
  receiptJson,
  receiptText,
} from "@/lib/receipt/export";
import type { ReceiptRecord } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";

afterEach(() => {
  cleanup();
  mock.restore();
});

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const MERGE = "a".repeat(64);
const OFFERS = "c".repeat(64);

function record(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "local-receipt-id",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    mediatorRequired: true,
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    memo: { text: "4242", type: "id" },
    transactions: [
      { txHash: OFFERS, label: "Cancel offers", stepTypes: ["CANCEL_OFFERS"], stepTitles: [] },
      { txHash: MERGE, label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] },
    ],
    groups: [{ type: "MERGE", title: "Account merged", summary: "to the destination", items: [] }],
    feeLumens: "0.0000200",
    receivedLumens: "1234.5000000",
    ...over,
  };
}

/** RFC 4180, as a spreadsheet reads it: quoted cells, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

test("the JSON follows the documented, versioned shape", () => {
  expect(JSON.parse(receiptJson(record()))).toEqual({
    format: "lumenwipe.receipt",
    version: 1,
    network: "testnet",
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    sourceAccount: SOURCE,
    destinationAccount: DEST,
    viaRelayAccount: true,
    memo: { type: "id", text: "4242" },
    receivedXlm: "1234.5000000",
    feesXlm: "0.0000200",
    transactions: [
      {
        hash: OFFERS,
        phase: "Cancel offers",
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${OFFERS}`,
      },
      {
        hash: MERGE,
        phase: "Merge",
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${MERGE}`,
      },
    ],
  });
});

test("the CSV has a header, one row per transaction and every receipt field on each", () => {
  const csv = receiptCsv(record());
  expect(csv.startsWith("﻿")).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  const [header, ...rows] = parseCsv(csv.slice(1));
  expect(header).toEqual([...CSV_COLUMNS]);
  expect(rows).toEqual([
    [
      "testnet",
      "closed",
      "2026-11-07T10:30:00.000Z",
      SOURCE,
      DEST,
      "yes",
      "id",
      "4242",
      "1234.5000000",
      "0.0000200",
      OFFERS,
      "Cancel offers",
      `https://stellar.expert/explorer/testnet/tx/${OFFERS}`,
    ],
    [
      "testnet",
      "closed",
      "2026-11-07T10:30:00.000Z",
      SOURCE,
      DEST,
      "yes",
      "id",
      "4242",
      "1234.5000000",
      "0.0000200",
      MERGE,
      "Merge",
      `https://stellar.expert/explorer/testnet/tx/${MERGE}`,
    ],
  ]);
});

test("a memo with commas, quotes and line breaks stays in its one cell", () => {
  const memo = 'pay, "now"\nthen\r\nlater';
  const csv = receiptCsv(record({ memo: { text: memo, type: "text" } }));
  expect(csv).toContain(`"pay, ""now""\nthen\r\nlater"`);
  const rows = parseCsv(csv.slice(1));
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.length === CSV_COLUMNS.length)).toBe(true);
  expect(rows[1][7]).toBe(memo);
});

test("a cell a spreadsheet would run as a formula is neutralised", () => {
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    const value = `${start}HYPERLINK("http://x.invalid")`;
    expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    const rows = parseCsv(receiptCsv(record({ memo: { text: value, type: "text" } })).slice(1));
    expect(rows[1][7]).toBe(`'${value}`);
  }
  // A negative number is neutralised too: the receipt has none, and a value column never needs one.
  expect(csvCell("-5")).toBe(`"'-5"`);
  expect(csvCell("a=b")).toBe(`"a=b"`);
  expect(csvCell(" =1")).toBe(`" =1"`);
});

test("a record with no stored amount says not recorded, never zero, in every output", () => {
  const old = record({
    memo: null,
    feeLumens: null,
    receivedLumens: null,
    completedAt: "not a date",
  });
  const data = receiptExport(old);
  expect(data.receivedXlm).toBe(NOT_RECORDED);
  expect(data.feesXlm).toBe(NOT_RECORDED);
  expect(data.memo).toBe(NOT_RECORDED);
  expect(data.completedAt).toBe(NOT_RECORDED);

  const row = parseCsv(receiptCsv(old).slice(1))[1];
  expect(row.slice(6, 10)).toEqual([NOT_RECORDED, NOT_RECORDED, NOT_RECORDED, NOT_RECORDED]);

  const lines = receiptText(old).split("\n");
  expect(lines).toContain("XLM received: not recorded");
  expect(lines).toContain("Fees: not recorded");
  expect(lines).toContain("Memo: not recorded");
  const text = lines.join("\n");
  for (const output of [receiptJson(old), receiptCsv(old), text]) {
    expect(output).not.toMatch(/(^|[^\d.])0(\.0+)?( XLM)?("|,|$)/m);
  }
});

test("the summary holds every receipt field and each transaction with its URL", () => {
  expect(receiptText(record()).split("\n")).toEqual([
    "LumenWipe receipt",
    "Outcome: closed",
    "Network: testnet",
    "Completed (UTC): 2026-11-07T10:30:00.000Z",
    `Source account: ${SOURCE}`,
    `Destination account: ${DEST}`,
    "Via relay account: yes",
    "Memo: 4242 (id)",
    "XLM received: 1234.5000000 XLM",
    "Fees: 0.0000200 XLM",
    "Transactions:",
    `- Cancel offers: ${OFFERS}`,
    `  https://stellar.expert/explorer/testnet/tx/${OFFERS}`,
    `- Merge: ${MERGE}`,
    `  https://stellar.expert/explorer/testnet/tx/${MERGE}`,
    "",
  ]);
});

test("a hand-edited value that is not a string still exports as one cell", () => {
  const odd = record({ memo: { text: "x", type: { nested: true } as never } });
  const row = parseCsv(receiptCsv(odd).slice(1))[1];
  expect(row).toHaveLength(CSV_COLUMNS.length);
  expect(row[6]).toBe("[object Object]");
});

test("a close without a memo, or with no transaction, still exports", () => {
  const none = record({ memo: { text: null, type: null }, transactions: [] });
  expect(receiptExport(none).memo).toEqual({ type: null, text: null });
  const rows = parseCsv(receiptCsv(none).slice(1));
  expect(rows).toHaveLength(2);
  expect(rows[1].slice(6, 8)).toEqual(["none", ""]);
  expect(rows[1].slice(10)).toEqual(["", "", ""]);
  expect(receiptText(none)).toContain("Memo: none");
});

test("a record naming no known network gets no explorer URL", () => {
  const data = receiptExport(record({ network: "/evil.example" as never }));
  expect(data.transactions.map((tx) => tx.explorerUrl)).toEqual([NOT_RECORDED, NOT_RECORDED]);
  expect(receiptJson(record({ network: "nope" as never }))).not.toContain("undefined");
});

test("nothing but the documented fields reaches any output", () => {
  const SECRET = "SBSECRETSEEDVALUESHOULDNEVERLEAVETHEBROWSER0000000000000000";
  const leaks = [
    SECRET,
    "AAAAAgAAAABENVELOPEXDR==",
    "AAAAAgAAAABSIGNEDXDR==",
    "AAAAAgAAAABUNSIGNEDXDR==",
    "SIGNERKEYGXXXXXXXX",
    "local-receipt-id",
    "Account merged",
    "to the destination",
    "GROUP-NOTE-TEXT",
  ];
  const seeded = {
    ...record({
      memo: { text: "4242", type: "id", secret: SECRET } as unknown as ReceiptRecord["memo"],
      groups: [
        {
          type: "NORMALIZE_SIGNERS",
          title: "Account merged",
          summary: "to the destination",
          items: [{ text: "SIGNERKEYGXXXXXXXX", detail: SECRET, mono: true }],
          note: "GROUP-NOTE-TEXT",
        },
      ],
    }),
    secretKey: SECRET,
    signer: { secret: SECRET, publicKey: "SIGNERKEYGXXXXXXXX" },
    envelopeXdr: "AAAAAgAAAABENVELOPEXDR==",
    signedXdr: "AAAAAgAAAABSIGNEDXDR==",
    txXdr: "AAAAAgAAAABUNSIGNEDXDR==",
  } as unknown as ReceiptRecord;
  seeded.transactions = seeded.transactions.map((tx) => ({
    ...tx,
    envelopeXdr: "AAAAAgAAAABENVELOPEXDR==",
    stepTitles: [SECRET],
  })) as ReceiptRecord["transactions"];

  const outputs = { json: receiptJson(seeded), csv: receiptCsv(seeded), text: receiptText(seeded) };
  for (const [kind, output] of Object.entries(outputs)) {
    for (const leak of leaks) {
      expect(`${kind}: ${output.includes(leak) ? leak : "clean"}`).toBe(`${kind}: clean`);
    }
  }
  expect(Object.keys(JSON.parse(outputs.json)).sort()).toEqual(
    [
      "completedAt",
      "destinationAccount",
      "feesXlm",
      "format",
      "memo",
      "network",
      "outcome",
      "receivedXlm",
      "sourceAccount",
      "transactions",
      "version",
      "viaRelayAccount",
    ].sort()
  );
  expect(Object.keys(JSON.parse(outputs.json).memo).sort()).toEqual(["text", "type"]);
  for (const tx of JSON.parse(outputs.json).transactions) {
    expect(Object.keys(tx).sort()).toEqual(["explorerUrl", "hash", "phase"]);
  }
});

test("the summary copy says whether it worked", async () => {
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  render(<ReceiptExportActions record={record()} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
  });
  expect(writeText).toHaveBeenCalledWith(receiptText(record()));
  expect(screen.getByRole("status").textContent).toBe("Summary copied.");

  writeText.mockRejectedValue(new Error("denied"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
  });
  expect(screen.getByRole("status").textContent).toBe(
    "Could not copy the summary. Download a file instead."
  );
});

test("each download is made here from the record, under its own name", async () => {
  const blobs: Blob[] = [];
  spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    blobs.push(blob as Blob);
    return "blob:receipt";
  });
  const revoked: string[] = [];
  spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => revoked.push(url));
  const names: string[] = [];
  spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    names.push(this.download);
  });
  const fetchSpy = spyOn(globalThis, "fetch");

  render(<ReceiptExportActions record={record()} context="of Nov 7, 2026" />);
  fireEvent.click(screen.getByRole("button", { name: "Download JSON of Nov 7, 2026" }));
  fireEvent.click(screen.getByRole("button", { name: "Download CSV of Nov 7, 2026" }));

  expect(names).toEqual([
    "lumenwipe-receipt-testnet-2026-11-07.json",
    "lumenwipe-receipt-testnet-2026-11-07.csv",
  ]);
  expect(receiptFileName(record(), "csv")).toBe("lumenwipe-receipt-testnet-2026-11-07.csv");
  expect(await blobs[0].text()).toBe(receiptJson(record()));
  expect(blobs[0].type).toBe("application/json");
  expect(blobs[1].type).toBe("text/csv;charset=utf-8");
  // The byte order mark is in the bytes, not lost when the blob is read back.
  expect(new Uint8Array(await blobs[1].arrayBuffer()).slice(0, 3)).toEqual(
    new Uint8Array([0xef, 0xbb, 0xbf])
  );
  expect(fetchSpy).not.toHaveBeenCalled();
  // Each blob URL is released once its download has had time to start.
  expect(revoked).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(revoked).toEqual(["blob:receipt", "blob:receipt"]);
});
