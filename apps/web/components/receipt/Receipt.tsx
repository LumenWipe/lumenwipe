import type { ReactNode } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { explorerTxUrl, SV_EXPLORER_BASE } from "@/config/networks";
import { formatXlm } from "@/lib/utils/amounts";
import { shortAddr, shortHash } from "@/lib/utils/short-id";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReceiptRecord } from "@/types/history";

const NOT_RECORDED = "Not recorded";

interface ReceiptProps {
  record: ReceiptRecord;
  /** The heading block: the live close and a reopened receipt each state their own outcome. */
  banner: ReactNode;
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
    <div className="flex justify-between gap-4 text-sm">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-mono-address text-xs text-white/70">
        {children}
      </span>
    </div>
  );
}

/** A close's receipt, drawn only from its record, so the live screen and a reopened receipt
 *  show the same thing. Anything the record lacks reads "Not recorded", never a guess. */
export default function Receipt({ record, banner, children }: ReceiptProps) {
  const svExplorerBase = SV_EXPLORER_BASE[record.network];
  const { groups, transactions: ledger, memo } = record;

  return (
    <div className="space-y-6">
      {banner}

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
                <div key={g.type} className="px-4 py-3.5">
                  <span className="flex min-w-0 items-start gap-2.5">
                    <StepTypeIcon
                      type={g.type}
                      className="mt-0.5 h-4 w-4 shrink-0 text-accent/70"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-white/85">{g.title}</span>
                      <span className="block truncate text-xs text-fg-subtle">{g.summary}</span>
                    </span>
                  </span>
                  <div className="mt-2 space-y-1 pl-[1.625rem] text-xs text-fg-muted">
                    {g.items.length > 0 && (
                      <ul className="space-y-1">
                        {g.items.map((item, i) => (
                          <li key={i} className="truncate">
                            <span className={item.mono ? "font-mono-address" : undefined}>
                              {item.text}
                            </span>
                            {item.detail && (
                              <span className="text-fg-subtle"> · {item.detail}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {g.note && <p>{g.note}</p>}
                  </div>
                </div>
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
              <div key={tx.txHash} className="flex items-center justify-between gap-4 px-4 py-3.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Link2 className="h-4 w-4 shrink-0 text-accent/70" />
                  <span className="min-w-0">
                    <span
                      className="block truncate text-sm font-medium text-white/85"
                      title={tx.stepTitles.join(" · ")}
                    >
                      {tx.label}
                    </span>
                    <span className="block font-mono-address text-xs text-fg-subtle">
                      {shortHash(tx.txHash)}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <a
                    href={explorerTxUrl(record.network, tx.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    SE <ExternalLink className="h-3 w-3" />
                  </a>
                  <a
                    href={`${svExplorerBase}/tx/${encodeURIComponent(tx.txHash)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    SV <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <SummaryRow label="Source account">{shortAddr(record.sourceAddress)}</SummaryRow>
        <SummaryRow label="Destination">{shortAddr(record.destinationAddress)}</SummaryRow>
        <SummaryRow label="Memo">{memo === null ? NOT_RECORDED : (memo.text ?? "None")}</SummaryRow>
        <SummaryRow label="Amount received">
          {record.receivedLumens === null ? NOT_RECORDED : formatXlm(record.receivedLumens)}
        </SummaryRow>
        <SummaryRow label="Total fees paid">
          {record.feeLumens === null ? NOT_RECORDED : formatXlm(record.feeLumens)}
        </SummaryRow>
        <SummaryRow label="Recorded">{completedAtUtc(record.completedAt)}</SummaryRow>
      </Card>

      {children}
    </div>
  );
}
