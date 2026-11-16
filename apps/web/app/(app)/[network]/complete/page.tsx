"use client";

import { use, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Network } from "@/config/networks";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import { receiptPath } from "@/lib/receipt/href";
import CompletionReceipt from "@/components/complete/CompletionReceipt";
import { Button } from "@/components/ui/button";

export default function CompletePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { confirmed } = useJourneyState();
  // Once saved, the receipt moves to its own address, which a refresh or a bookmark reopens.
  const onSaved = useCallback(
    (id: string) => router.replace(receiptPath(network, id)),
    [network, router]
  );

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {confirmed > 0 ? (
        <CompletionReceipt network={network} onSaved={onSaved} />
      ) : (
        <NoCloseOpen network={network} />
      )}
    </div>
  );
}

/** This page shows only the close this tab holds, which a refresh or a new tab does not have. */
function NoCloseOpen({ network }: { network: Network }) {
  return (
    <div className="space-y-4 text-center">
      <h1 className="mkt-display text-2xl font-bold text-white">No close to show here</h1>
      <p className="text-sm text-fg-muted">
        This page shows a close only while the tab that ran it is open, so a refresh or a new tab
        leaves it empty. When a close finishes, its receipt is kept in this browser: open it from
        the history icon in the navigation bar.
      </p>
      <Button asChild variant="secondary">
        <Link href={`/${network}`}>Back to the start</Link>
      </Button>
    </div>
  );
}
