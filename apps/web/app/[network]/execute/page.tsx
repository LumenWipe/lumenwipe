"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { routeForPhase } from "@/lib/plan/route-for-phase";
import ExecutionWizard from "@/components/execution/ExecutionWizard";
import { Button } from "@/components/ui/button";

export default function ExecutePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress, phase, planChangedNotice } = useDemolishStore();

  // Checked once at mount, not on every phase change: STEP_EXECUTING legitimately moves
  // through STEP_CONFIRMED/STEP_FAILED/COMPLETE while this page stays mounted during a
  // real close, and that must never bounce the user away mid-flow. This only catches landing
  // here directly (a stale bookmark, or forward-navigating past /review without confirming),
  // and sends the close to the page its phase belongs on.
  useEffect(() => {
    if (sourceAddress && executionPlan.length === 0 && planChangedNotice) {
      router.replace(`/${network}/analyze`);
      return;
    }
    if (!sourceAddress || executionPlan.length === 0) {
      router.replace(`/${network}`);
      return;
    }
    const route = routeForPhase(phase);
    if (route !== "execute") router.replace(`/${network}/${route}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAddress, executionPlan.length, network, router]);

  if (!sourceAddress || executionPlan.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/${network}/analyze`} aria-label="Back to analyze">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="mkt-display text-xl font-bold text-white">Executing plan</h1>
        <span className="text-xs text-fg-subtle ml-auto mkt-mono">
          {sourceAddress.slice(0, 8)}...{sourceAddress.slice(-8)}
        </span>
      </div>

      <ExecutionWizard network={network} />
    </div>
  );
}
