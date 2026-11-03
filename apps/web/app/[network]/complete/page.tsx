"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { routeForPhase } from "@/lib/journey/route-for-phase";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import CompletionReceipt from "@/components/complete/CompletionReceipt";

export default function CompletePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const phase = useDemolishStore((s) => s.phase);
  const { confirmed } = useJourneyState();

  useEffect(() => {
    if (routeForPhase(phase) !== "complete" && confirmed === 0) router.replace(`/${network}`);
  }, [phase, confirmed, network, router]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <CompletionReceipt network={network} />
    </div>
  );
}
