"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { AlertTriangle, CheckCircle, Download, ExternalLink, History } from "lucide-react";
import Link from "next/link";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { cleanupSession } from "@/lib/session/recovery";
import { saveHistory } from "@/lib/session/history";
import { allows } from "@/lib/journey/claims";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import { buildReceiptRecord } from "@/lib/receipt/build-record";
import { downloadReceiptJson } from "@/lib/receipt/download";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import Receipt from "@/components/receipt/Receipt";
import ReceiptActions from "@/components/receipt/ReceiptActions";

interface CompletionReceiptProps {
  network: Network;
  /** Called once a finished close's receipt is saved, with the id it was saved under. */
  onSaved?: (id: string) => void;
}

/** Where the receipt's write to this browser's history stands. */
export type SaveState = "saving" | "saved" | "failed";

export default function CompletionReceipt({ network, onSaved }: CompletionReceiptProps) {
  const store = useDemolishStore();
  const { sourceAddress, sessionId } = store;

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
        () => {
          setSave("saved");
          if (record.outcome === "closed") onSaved?.(record.id);
        },
        (err: unknown) => {
          console.error("[receipt] save failed:", err);
          setSave("failed");
        }
      )
      .then(() => (finished && sessionId ? cleanupSession(sessionId) : undefined));
  }, [record, journey.mayBeInFlight, sessionId, onSaved]);

  const banner = closed ? (
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
  );

  if (!record) return banner;

  return (
    <Receipt record={record} banner={banner}>
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

      {save === "failed" && (
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
            href={`${SE_EXPLORER_BASE[network]}/account/${sourceAddress}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View the account on Stellar Expert
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}

      {closed && (
        <ReceiptActions network={network} destinationAddress={record.destinationAddress} />
      )}
    </Receipt>
  );
}
