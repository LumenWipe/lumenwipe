"use client";

import { useState } from "react";
import { Copy, Download } from "lucide-react";
import { downloadReceipt } from "@/lib/receipt/download";
import { receiptText } from "@/lib/receipt/export";
import { cn } from "@/lib/utils/cn";
import type { ReceiptRecord } from "@/types/history";

interface ReceiptExportActionsProps {
  record: ReceiptRecord;
  /** Names which receipt, for the accessible names where several are listed, e.g. "of 7 Nov". */
  context?: string;
  className?: string;
}

const ACTION =
  "inline-flex items-center gap-1 rounded text-xs text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

/** Copy a plain-text summary, or download the receipt as JSON or CSV. Everything is made here
 *  from the saved record: nothing is sent anywhere. */
export default function ReceiptExportActions({
  record,
  context,
  className,
}: ReceiptExportActionsProps) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const which = context ? <span className="sr-only"> {context}</span> : null;

  async function copySummary(): Promise<void> {
    try {
      await navigator.clipboard.writeText(receiptText(record));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      <button type="button" onClick={copySummary} className={ACTION}>
        <Copy className="h-3.5 w-3.5" aria-hidden />
        Copy summary{which}
      </button>
      <button type="button" onClick={() => downloadReceipt(record, "json")} className={ACTION}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        Download JSON{which}
      </button>
      <button type="button" onClick={() => downloadReceipt(record, "csv")} className={ACTION}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        Download CSV{which}
      </button>
      <span role="status" className="text-xs text-fg-muted">
        {copy === "copied"
          ? "Summary copied."
          : copy === "failed"
            ? "Could not copy the summary. Download a file instead."
            : ""}
      </span>
    </div>
  );
}
