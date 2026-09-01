"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import ExecutionWizard from "@/components/execution/ExecutionWizard";

export default function ExecutePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress, phase } = useDemolishStore();

  // Checked once at mount, not on every phase change: STEP_EXECUTING legitimately moves
  // through STEP_CONFIRMED/STEP_FAILED/COMPLETE while this page stays mounted during a
  // real close, and that must never bounce the user back to /review mid-flow. This only
  // catches landing here directly (a stale bookmark, or forward-navigating past /review
  // without confirming), where phase is still whatever it was before the gate.
  useEffect(() => {
    if (!sourceAddress || executionPlan.length === 0) {
      router.replace(`/${network}`);
      return;
    }
    if (phase !== "STEP_EXECUTING") {
      router.replace(`/${network}/review`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAddress, executionPlan.length, network, router]);

  if (!sourceAddress || executionPlan.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Link
          href={`/${network}/analyze`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="mkt-display text-xl font-bold text-white">Executing plan</h1>
        <span className="text-xs text-white/45 ml-auto mkt-mono">
          {sourceAddress.slice(0, 8)}...{sourceAddress.slice(-8)}
        </span>
      </div>

      <ExecutionWizard network={network} />
    </div>
  );
}
