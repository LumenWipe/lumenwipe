import { explorerTxUrl, isValidNetwork } from "@/config/networks";
import type { ReceiptRecord } from "@/types/history";

/** Names the file's shape, so a reader can tell a receipt from any other JSON. */
export const RECEIPT_EXPORT_FORMAT = "lumenwipe.receipt";
/** Raised whenever a field is renamed, removed or changes meaning. Adding one does not raise it. */
export const RECEIPT_EXPORT_VERSION = 1;
/** What a field reads when the record does not hold it: never zero, never empty. */
export const NOT_RECORDED = "not recorded";

type NotRecorded = typeof NOT_RECORDED;

export interface ReceiptExportTransaction {
  hash: string;
  /** What the transaction carried out, as the receipt labels it. */
  phase: string;
  explorerUrl: string | NotRecorded;
}

/** A receipt as it leaves the browser: the documented, versioned shape, and nothing else. */
export interface ReceiptExport {
  format: typeof RECEIPT_EXPORT_FORMAT;
  version: typeof RECEIPT_EXPORT_VERSION;
  network: string;
  outcome: ReceiptRecord["outcome"];
  /** UTC, ISO 8601. */
  completedAt: string | NotRecorded;
  sourceAccount: string;
  destinationAccount: string;
  viaRelayAccount: boolean;
  /** `text` and `type` are null when the close had no memo. */
  memo: { type: "text" | "id" | "hash" | null; text: string | null } | NotRecorded;
  receivedXlm: string | NotRecorded;
  feesXlm: string | NotRecorded;
  transactions: ReceiptExportTransaction[];
}

function utc(iso: string): string | NotRecorded {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? NOT_RECORDED : date.toISOString();
}

/**
 * The receipt's exported form. Every field is picked by name from the record, so nothing else
 * it holds, such as its local id or its "what was done" groups, can reach a file.
 */
export function receiptExport(record: ReceiptRecord): ReceiptExport {
  const { network } = record;
  return {
    format: RECEIPT_EXPORT_FORMAT,
    version: RECEIPT_EXPORT_VERSION,
    network,
    outcome: record.outcome,
    completedAt: utc(record.completedAt),
    sourceAccount: record.sourceAddress,
    destinationAccount: record.destinationAddress,
    viaRelayAccount: record.mediatorRequired,
    memo: record.memo === null ? NOT_RECORDED : { type: record.memo.type, text: record.memo.text },
    receivedXlm: record.receivedLumens ?? NOT_RECORDED,
    feesXlm: record.feeLumens ?? NOT_RECORDED,
    transactions: record.transactions.map((tx) => ({
      hash: tx.txHash,
      phase: tx.label,
      explorerUrl: isValidNetwork(network) ? explorerTxUrl(network, tx.txHash) : NOT_RECORDED,
    })),
  };
}

export function receiptJson(record: ReceiptRecord): string {
  return `${JSON.stringify(receiptExport(record), null, 2)}\n`;
}

export const CSV_COLUMNS = [
  "network",
  "outcome",
  "completed_at_utc",
  "source_account",
  "destination_account",
  "via_relay_account",
  "memo_type",
  "memo",
  "received_xlm",
  "fees_xlm",
  "transaction_hash",
  "phase",
  "explorer_url",
] as const;

/** Written first, so a spreadsheet reads the file as UTF-8. */
const BOM = "\uFEFF";

/** A cell a spreadsheet could read as a formula starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: neutralised against formula injection with a leading apostrophe, then quoted,
 *  with any quote inside doubled. Every cell is quoted, so commas and line breaks stay in it. */
export function csvCell(value: string): string {
  // A stored record can be edited by hand: a value that is not a string still becomes one cell.
  const text = String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The receipt as CSV: a header row, then one row per transaction with the receipt's own fields
 * repeated on each, so every row stands alone. A receipt with no transaction has one row with
 * those cells empty. UTF-8 with a byte order mark, so spreadsheets read it as UTF-8, and CRLF
 * line ends.
 */
export function receiptCsv(record: ReceiptRecord): string {
  const data = receiptExport(record);
  const memo =
    data.memo === NOT_RECORDED
      ? [NOT_RECORDED, NOT_RECORDED]
      : data.memo.text === null
        ? ["none", ""]
        : [data.memo.type ?? "", data.memo.text];
  const shared = [
    data.network,
    data.outcome,
    data.completedAt,
    data.sourceAccount,
    data.destinationAccount,
    data.viaRelayAccount ? "yes" : "no",
    ...memo,
    data.receivedXlm,
    data.feesXlm,
  ];
  const transactions = data.transactions.length > 0 ? data.transactions : [null];
  const rows = [
    [...CSV_COLUMNS],
    ...transactions.map((tx) => [
      ...shared,
      tx?.hash ?? "",
      tx?.phase ?? "",
      tx?.explorerUrl ?? "",
    ]),
  ];
  return `${BOM}${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function withUnit(xlm: string): string {
  return xlm === NOT_RECORDED ? xlm : `${xlm} XLM`;
}

/** The receipt as plain text, for the clipboard: the same fields as the files. */
export function receiptText(record: ReceiptRecord): string {
  const data = receiptExport(record);
  const memo =
    data.memo === NOT_RECORDED
      ? NOT_RECORDED
      : data.memo.text === null
        ? "none"
        : `${data.memo.text} (${data.memo.type ?? "unknown type"})`;
  return [
    "LumenWipe receipt",
    `Outcome: ${data.outcome}`,
    `Network: ${data.network}`,
    `Completed (UTC): ${data.completedAt}`,
    `Source account: ${data.sourceAccount}`,
    `Destination account: ${data.destinationAccount}`,
    `Via relay account: ${data.viaRelayAccount ? "yes" : "no"}`,
    `Memo: ${memo}`,
    `XLM received: ${withUnit(data.receivedXlm)}`,
    `Fees: ${withUnit(data.feesXlm)}`,
    "Transactions:",
    ...data.transactions.flatMap((tx) => [`- ${tx.phase}: ${tx.hash}`, `  ${tx.explorerUrl}`]),
    "",
  ].join("\n");
}
