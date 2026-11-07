import { receiptCsv, receiptJson } from "@/lib/receipt/export";
import type { ReceiptRecord } from "@/types/history";

export type ReceiptFileKind = "json" | "csv";

const MEDIA_TYPE: Record<ReceiptFileKind, string> = {
  json: "application/json",
  csv: "text/csv;charset=utf-8",
};

/** The file name a downloaded receipt is saved under. */
export function receiptFileName(record: ReceiptRecord, kind: ReceiptFileKind): string {
  return `lumenwipe-receipt-${record.network}-${record.completedAt.slice(0, 10)}.${kind}`;
}

/** Hands the receipt to the user as a file, in its documented shape. Built in the browser from
 *  the saved record and never uploaded. */
export function downloadReceipt(record: ReceiptRecord, kind: ReceiptFileKind): void {
  const body = kind === "json" ? receiptJson(record) : receiptCsv(record);
  const url = URL.createObjectURL(new Blob([body], { type: MEDIA_TYPE[kind] }));
  const link = document.createElement("a");
  link.href = url;
  link.download = receiptFileName(record, kind);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers start the download after the click returns: the URL outlives it a little.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
