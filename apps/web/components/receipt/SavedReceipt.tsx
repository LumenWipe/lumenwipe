"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Network } from "@/config/networks";
import { explorerAccountUrl, isValidNetwork } from "@/config/networks";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";
import { useReceivedLumens } from "@/hooks/useReceivedLumens";
import { getHistory } from "@/lib/session/history";
import { receiptPath } from "@/lib/receipt/href";
import Receipt from "@/components/receipt/Receipt";
import ReceiptActions from "@/components/receipt/ReceiptActions";
import ReceiptExportActions from "@/components/receipt/ReceiptExportActions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { ReceiptRecord } from "@/types/history";

type Load =
  | { state: "loading" }
  | { state: "found"; record: ReceiptRecord }
  | { state: "missing" }
  | { state: "error" };

/** A receipt reopened from this browser's history, read from IndexedDB only. Its id is a random
 *  one in the page address, linked to no account; the record itself never leaves the device. */
export default function SavedReceipt({ network, id }: { network: Network; id: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const read = useCallback(() => {
    setLoad({ state: "loading" });
    getHistory(id).then(
      // A record naming no network this app knows is not one it can show or link to.
      (record) =>
        setLoad(
          record && isValidNetwork(record.network)
            ? { state: "found", record }
            : { state: "missing" }
        ),
      (err: unknown) => {
        console.error("[receipt] read failed:", err);
        setLoad({ state: "error" });
      }
    );
  }, [id]);

  useEffect(read, [read]);

  const wrongNetwork = load.state === "found" && load.record.network !== network;
  // A receipt with no amount yet asks the ledger once, and keeps what it learns.
  const { received, retry } = useReceivedLumens(load.state === "found" ? load.record : null, {
    enabled: !wrongNetwork,
    persist: true,
  });
  useEffect(() => {
    if (load.state === "found" && wrongNetwork) {
      router.replace(receiptPath(load.record.network, load.record.id));
    }
  }, [load, wrongNetwork, router]);

  useEffect(() => {
    if (load.state === "found") {
      document.title =
        load.record.outcome === "closed"
          ? "Account closed | LumenWipe"
          : "Close incomplete | LumenWipe";
    } else if (load.state !== "loading") {
      document.title = "Receipt | LumenWipe";
    }
  }, [load]);

  if (load.state === "loading" || wrongNetwork) {
    return <p className="py-12 text-center text-sm text-fg-muted">Loading the receipt…</p>;
  }
  if (load.state === "error") return <ReadFailed onRetry={read} network={network} />;
  if (load.state === "missing") return <NotOnThisDevice network={network} />;

  // The amount the lookup found is in the files as soon as it is shown.
  const record =
    received.state === "recorded" && load.record.receivedLumens === null
      ? { ...load.record, receivedLumens: received.lumens }
      : load.record;
  return (
    <Receipt
      record={record}
      banner={<SavedBanner record={record} />}
      received={received}
      onRetryReceived={retry}
    >
      <p className="text-xs text-fg-muted">
        Kept in this browser only. Deleting it from the history removes it from this device.
      </p>
      <ReceiptExportActions record={record} />
      {record.outcome === "closed" && (
        <ReceiptActions network={record.network} destinationAddress={record.destinationAddress} />
      )}
    </Receipt>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  const ref = useFocusOnMount<HTMLHeadingElement>();
  return (
    <h1 ref={ref} tabIndex={-1} className="mkt-display text-2xl font-bold text-white outline-none">
      {children}
    </h1>
  );
}

/** The outcome as the receipt recorded it when the close page was reached. */
function SavedBanner({ record }: { record: ReceiptRecord }) {
  if (record.outcome === "closed") {
    return (
      <Callout
        tone="success"
        announce="status"
        icon={<CheckCircle className="h-12 w-12" />}
        title={<Heading>Account successfully merged</Heading>}
        className="flex-col items-center gap-3 p-6 text-center"
      >
        The merge transaction confirmed and the account was removed from the Stellar ledger.
      </Callout>
    );
  }
  return (
    <Callout
      tone="warning"
      announce="status"
      icon={<AlertTriangle className="h-12 w-12" />}
      title={<Heading>Close not finished</Heading>}
      className="flex-col items-center gap-3 p-6 text-center"
      action={
        <Button asChild variant="secondary">
          <Link
            href={explorerAccountUrl(record.network, record.sourceAddress)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View the account on Stellar Expert
            <span className="sr-only"> (opens in a new tab)</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </Button>
      }
    >
      This receipt was saved before the merge confirmed. The close may have been finished since: the
      explorer shows the account as it is now.
    </Callout>
  );
}

function NotOnThisDevice({ network }: { network: Network }) {
  return (
    <div className="space-y-4 text-center">
      <Heading>Receipt not found in this browser</Heading>
      <p className="text-sm text-fg-muted">
        Receipts are stored only in the browser that made them, and are never uploaded. This one is
        not here: it may have been made on another device or browser, or deleted from the history.
      </p>
      <Button asChild variant="secondary">
        <Link href={`/${network}`}>Back to the start</Link>
      </Button>
    </div>
  );
}

function ReadFailed({ network, onRetry }: { network: Network; onRetry: () => void }) {
  return (
    <div className="space-y-4 text-center">
      <Heading>The receipt could not be read</Heading>
      <p className="text-sm text-fg-muted">
        This browser&apos;s storage could not be opened, which happens when it is blocked or in some
        private windows. Nothing is known about this receipt until it can be read.
      </p>
      <div className="flex justify-center gap-3">
        <Button onClick={onRetry}>Try again</Button>
        <Button asChild variant="secondary">
          <Link href={`/${network}`}>Back to the start</Link>
        </Button>
      </div>
    </div>
  );
}
