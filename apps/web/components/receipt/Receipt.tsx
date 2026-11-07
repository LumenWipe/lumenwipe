"use client";

import type { ReactNode } from "react";
import { Link2 } from "lucide-react";
import { explorerTxUrl, SV_EXPLORER_BASE } from "@/config/networks";
import { formatXlm } from "@/lib/utils/amounts";
import { shortHash } from "@/lib/utils/short-id";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ExplorerLink } from "@/components/ui/explorer-link";
import { IdentifierDisplay } from "@/components/ui/identifier-display";
import ReceiptGroupRow from "@/components/receipt/ReceiptGroupRow";
import ReceiptHeadline from "@/components/receipt/ReceiptHeadline";
import type { ReceivedState } from "@/hooks/useReceivedLumens";
import type { ReceiptRecord } from "@/types/history";

const NOT_RECORDED = "Not recorded";

interface ReceiptProps {
  record: ReceiptRecord;
  /** The heading block: the live close and a reopened receipt each state their own outcome. */
  banner: ReactNode;
  /** The XLM received, as far as it is known; a closed receipt leads with it. */
  received: ReceivedState;
  onRetryReceived: () => void;
  /** What follows the receipt: save status and actions. */
  children?: ReactNode;
}

function completedAtUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_RECORDED;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 text-right font-mono-address text-xs text-white/85">{children}</span>
    </div>
  );
}

/** A close's receipt, drawn only from its record, so the live screen and a reopened receipt
 *  show the same thing. Anything the record lacks reads "Not recorded", never a guess. */
export default function Receipt({
  record,
  banner,
  received,
  onRetryReceived,
  children,
}: ReceiptProps) {
  const svExplorerBase = SV_EXPLORER_BASE[record.network];
  const { groups, transactions: ledger, memo } = record;
  const closed = record.outcome === "closed";

  return (
    <div data-receipt className="space-y-6">
      {banner}

      {closed && <ReceiptHeadline record={record} received={received} onRetry={onRetryReceived} />}

      {groups === null ? (
        <Card className="p-4 text-sm">
          <p className="font-medium text-white/85">What was done</p>
          <p className="mt-1 text-xs text-fg-muted">
            {NOT_RECORDED}: this receipt was saved before the details of each step were kept.
          </p>
        </Card>
      ) : (
        groups.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>What was done</CardTitle>
            </CardHeader>
            <div className="divide-y divide-white/8">
              {groups.map((g) => (
                <ReceiptGroupRow key={g.type} group={g} />
              ))}
            </div>
          </Card>
        )
      )}

      {ledger.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>
              {ledger.length === 1 ? "Transaction" : `Transactions · ${ledger.length}`}
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-white/8">
            {ledger.map((tx) => (
              <div key={tx.txHash} className="flex items-start gap-2.5 px-4 py-3.5">
                <Link2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent/70" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="text-sm font-medium text-white/85"
                    title={tx.stepTitles.join(" · ")}
                  >
                    {tx.label}
                  </p>
                  <IdentifierDisplay
                    value={tx.txHash}
                    kind="hash"
                    label={`hash of ${tx.label}`}
                    className="text-xs text-fg-muted"
                  />
                  <p className="flex flex-wrap gap-x-3 print:hidden">
                    <ExplorerLink
                      href={explorerTxUrl(record.network, tx.txHash)}
                      target={`transaction ${shortHash(tx.txHash)}`}
                    >
                      Stellar Expert
                    </ExplorerLink>
                    <ExplorerLink
                      href={`${svExplorerBase}/tx/${encodeURIComponent(tx.txHash)}`}
                      target={`transaction ${shortHash(tx.txHash)}`}
                    >
                      StellarView
                    </ExplorerLink>
                  </p>
                  <p data-print-only className="break-all text-xs">
                    {explorerTxUrl(record.network, tx.txHash)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <SummaryRow label="Source account">
          <IdentifierDisplay value={record.sourceAddress} kind="address" label="source account" />
        </SummaryRow>
        {!closed && (
          <SummaryRow label="Destination">
            <IdentifierDisplay
              value={record.destinationAddress}
              kind="address"
              label="destination address"
            />
          </SummaryRow>
        )}
        <SummaryRow label="Memo">{memo === null ? NOT_RECORDED : (memo.text ?? "None")}</SummaryRow>
        <SummaryRow label="Total fees paid">
          {record.feeLumens === null ? NOT_RECORDED : formatXlm(record.feeLumens)}
        </SummaryRow>
        <SummaryRow label="Recorded">{completedAtUtc(record.completedAt)}</SummaryRow>
      </Card>

      {children}
    </div>
  );
}
