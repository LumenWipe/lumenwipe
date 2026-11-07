"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { explorerAccountUrl, SV_EXPLORER_BASE } from "@/config/networks";
import { journeyOf } from "@/lib/journey/journey-state";
import { useDemolishStore } from "@/store/demolish";
import { shortAddr } from "@/lib/utils/short-id";
import { Button } from "@/components/ui/button";
import { ExplorerLink } from "@/components/ui/explorer-link";

/** The actions after a finished close: the destination on an explorer as the one primary action,
 *  starting another close as the secondary, and the second explorer as a text link. */
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

  const short = shortAddr(destinationAddress);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center print:hidden">
      <Button asChild>
        <a
          href={explorerAccountUrl(network, destinationAddress)}
          target="_blank"
          rel="noopener noreferrer"
        >
          View destination on Stellar Expert
          <span className="sr-only"> - account {short}, opens in a new tab</span>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </Button>
      <Button asChild variant="secondary">
        <Link href={`/${network}`} onClick={closeAnother}>
          Close another account
        </Link>
      </Button>
      <ExplorerLink
        href={`${SV_EXPLORER_BASE[network]}/account/${encodeURIComponent(destinationAddress)}`}
        target={`account ${short}`}
        className="self-center sm:ml-auto"
      >
        View on StellarView
      </ExplorerLink>
    </div>
  );
}
