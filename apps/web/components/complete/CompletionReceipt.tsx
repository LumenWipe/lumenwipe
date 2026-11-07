"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { AlertTriangle, CheckCircle, Download, ExternalLink, History, Link2 } from "lucide-react";
import Link from "next/link";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { shortAddr, shortHash } from "@/lib/utils/short-id";
import { useDemolishStore } from "@/store/demolish";
import { cleanupSession } from "@/lib/session/recovery";
import { saveHistory } from "@/lib/session/history";
import { allows } from "@/lib/journey/claims";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import { buildReceiptRecord } from "@/lib/receipt/build-record";
import { downloadReceiptJson } from "@/lib/receipt/download";
import { formatXlm } from "@/lib/utils/amounts";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

interface CompletionReceiptProps {
  network: Network;
}

/** Where the receipt's write to this browser's history stands. */
export type SaveState = "saving" | "saved" | "failed";

export default function CompletionReceipt({ network }: CompletionReceiptProps) {
  const store = useDemolishStore();
  const { sourceAddress, destinationAddress, sessionId, reset } = store;
  const explorerBase = SE_EXPLORER_BASE[network];
  const svExplorerBase = SV_EXPLORER_BASE[network];

  const journey = useJourneyState();
  const closed = allows(journey, "account-closed");

  // A close without a session id still gets a receipt, under an id of its own for this visit.
  const [fallbackId] = useState(() => uuidv4());
  const [completedAt] = useState(() => new Date().toISOString());
  const receiptId = sessionId ?? fallbackId;
  const record = useMemo(
    () => buildReceiptRecord(store, { id: receiptId, network, completedAt }),
    [store, receiptId, network, completedAt]
  );

  const headingRef = useFocusOnMount<HTMLHeadingElement>();
  const [save, setSave] = useState<SaveState | null>(null);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    document.title = closed ? "Account closed | LumenWipe" : "Close incomplete | LumenWipe";
  }, [closed]);

  useEffect(() => {
    if (!record || record.transactions.length === 0) return;
    const key = `${record.id}:${record.outcome}`;
    if (attempted.current === key) return;
    attempted.current = key;
    // Only a close that finished, with nothing left in flight, gives up its resumable session:
    // for anything less the session is the only way back into the close.
    const finished = record.outcome === "closed" && !journey.mayBeInFlight;
    setSave("saving");
    saveHistory(record)
      .then(
        () => setSave("saved"),
        (err: unknown) => {
          console.error("[receipt] save failed:", err);
          setSave("failed");
        }
      )
      .then(() => (finished && sessionId ? cleanupSession(sessionId) : undefined));
  }, [record, journey.mayBeInFlight, sessionId]);

  const groups = record?.groups ?? [];
  const ledger = record?.transactions ?? [];

  return (
    <div className="space-y-6">
      {closed ? (
        <Callout
          tone="success"
          icon={<CheckCircle className="h-12 w-12" />}
          title={
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mkt-display text-2xl font-bold text-white outline-none"
            >
              Account successfully merged
            </h1>
          }
          className="flex-col items-center gap-3 p-6 text-center"
        >
          All assets have been transferred and the account has been removed from the Stellar ledger.
        </Callout>
      ) : (
        <Callout
          tone="warning"
          announce="status"
          icon={<AlertTriangle className="h-12 w-12" />}
          title={
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mkt-display text-2xl font-bold text-white outline-none"
            >
              Close not finished
            </h1>
          }
          className="flex-col items-center gap-3 p-6 text-center"
          action={
            <Button asChild>
              <Link href={`/${network}`}>Resume</Link>
            </Button>
          }
        >
          {journey.confirmed} of {journey.total} transactions confirmed. The account still exists.
          Resume the close to finish it.
        </Callout>
      )}

      {/* Grouped summary */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>What was done</CardTitle>
        </CardHeader>
        <div className="divide-y divide-white/8">
          {groups.map((g) => (
            <div key={g.type} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <span className="flex min-w-0 items-start gap-2.5">
                  <StepTypeIcon type={g.type} className="h-4 w-4 mt-0.5 shrink-0 text-accent/70" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-white/85">{g.title}</span>
                    <span className="block truncate text-xs text-fg-subtle">{g.summary}</span>
                  </span>
                </span>
              </div>
              <div className="mt-2 space-y-1 pl-[1.625rem] text-xs text-fg-muted">
                {g.items.length > 0 && (
                  <ul className="space-y-1">
                    {g.items.map((item, i) => (
                      <li key={i} className="truncate">
                        <span className={item.mono ? "font-mono-address" : undefined}>
                          {item.text}
                        </span>
                        {item.detail && <span className="text-fg-subtle"> · {item.detail}</span>}
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

      {/* Transaction ledger */}
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
                    href={`${explorerBase}/tx/${tx.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    SE <ExternalLink className="h-3 w-3" />
                  </a>
                  <a
                    href={`${svExplorerBase}/tx/${tx.txHash}`}
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

      {/* Summary */}
      <Card className="space-y-3 p-4">
        <div className="flex justify-between text-sm">
          <span className="text-fg-muted">Source account</span>
          <span className="font-mono-address text-xs text-white/70">
            {sourceAddress && shortAddr(sourceAddress)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-fg-muted">Destination</span>
          <span className="font-mono-address text-xs text-white/70">
            {destinationAddress && shortAddr(destinationAddress)}
          </span>
        </div>
        <div className="flex justify-between gap-4 text-sm">
          <span className="text-fg-muted">Memo</span>
          <span className="min-w-0 truncate font-mono-address text-xs text-white/70">
            {record?.memo?.text ?? "None"}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-fg-muted">Total fees paid</span>
          <span className="text-xs mkt-mono text-white/70">
            {record?.feeLumens ? formatXlm(record.feeLumens) : "Not recorded"}
          </span>
        </div>
      </Card>

      <div aria-live="polite">
        {save === "saving" && <p className="text-xs text-fg-muted">Saving the receipt…</p>}
        {save === "saved" && allows(journey, "receipt-saved") && (
          <Callout
            tone="info"
            announce={false}
            icon={<History className="h-4 w-4" />}
            className="p-3 text-xs"
          >
            Receipt saved to this browser. You can open it again from the history icon in the
            navigation bar.
          </Callout>
        )}
      </div>

      {save === "failed" && record && (
        <Callout
          tone="warning"
          announce="alert"
          icon={<AlertTriangle className="h-4 w-4" />}
          className="p-3 text-xs"
          action={
            <Button size="sm" onClick={() => downloadReceiptJson(record)}>
              <Download className="h-3.5 w-3.5" />
              Download receipt
            </Button>
          }
        >
          This browser could not keep the receipt, so it will not be in your history. Storage may be
          blocked or full, as in a private window. Download it now to keep a copy.
        </Callout>
      )}

      {!closed && sourceAddress && (
        <Button asChild variant="secondary" className="w-full">
          <Link
            href={`${explorerBase}/account/${sourceAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View the account on Stellar Expert
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}

      {closed && (
        <div className="flex gap-3">
          <Button variant="secondary" onClick={reset} className="flex-1">
            Merge another account
          </Button>
          <Button asChild className="flex-1">
            <Link
              href={`${explorerBase}/account/${destinationAddress}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Stellar Expert
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button asChild variant="secondary" className="flex-1">
            <Link
              href={`${svExplorerBase}/account/${destinationAddress}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              StellarView
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
