import type { ReceiptRecord } from "@/types/history";

/** The file name a downloaded receipt is saved under. */
export function receiptFileName(record: ReceiptRecord): string {
  return `lumenwipe-receipt-${record.network}-${record.completedAt.slice(0, 10)}.json`;
}

/** Hands the receipt to the user as a JSON file. Built in the browser and never uploaded. */
export function downloadReceiptJson(record: ReceiptRecord): void {
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = receiptFileName(record);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
