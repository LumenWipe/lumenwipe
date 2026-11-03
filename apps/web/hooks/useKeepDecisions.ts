"use client";

import { useEffect } from "react";
import type { Network } from "@/config/networks";
import { keepDecisions } from "@/lib/session/restore-decisions";
import { useDemolishStore } from "@/store/demolish";

/** Keeps this tab's inputs for `source` saved while the page is open, until the store leaves the
 *  close it held when this started. */
export function useKeepDecisions(network: Network, source: string | null, enabled = true): void {
  useEffect(() => {
    if (!enabled || !source) return;
    const epoch = useDemolishStore.getState().closeEpoch;
    const keep = () => {
      if (useDemolishStore.getState().closeEpoch === epoch) keepDecisions(network, source);
    };
    keep();
    return useDemolishStore.subscribe(keep);
  }, [network, source, enabled]);
}
