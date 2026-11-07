"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { explorerAccountUrl, SV_EXPLORER_BASE } from "@/config/networks";
import { journeyOf } from "@/lib/journey/journey-state";
import { useDemolishStore } from "@/store/demolish";
import { Button } from "@/components/ui/button";

/** The actions after a finished close: start another, or look at the destination. */
export default function ReceiptActions({
  network,
  destinationAddress,
}: {
  network: Network;
  destinationAddress: string;
}) {
  function closeAnother(): void {
    // Only a finished close is cleared: a receipt reopened from history mid-close leaves the
    // close this tab holds alone.
    const store = useDemolishStore.getState();
    if (journeyOf(store).state === "complete") store.reset();
  }

  return (
    <div className="flex gap-3">
      <Button asChild variant="secondary" className="flex-1">
        <Link href={`/${network}`} onClick={closeAnother}>
          Merge another account
        </Link>
      </Button>
      <Button asChild className="flex-1">
        <Link
          href={explorerAccountUrl(network, destinationAddress)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Stellar Expert
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
      <Button asChild variant="secondary" className="flex-1">
        <Link
          href={`${SV_EXPLORER_BASE[network]}/account/${encodeURIComponent(destinationAddress)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          StellarView
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
