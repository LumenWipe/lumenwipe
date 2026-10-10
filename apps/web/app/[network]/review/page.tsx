"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { goBackToAnalyze } from "@/lib/plan/confirm-plan";
import ReviewView from "@/components/review/ReviewView";
import StatusMessage from "@/components/a11y/StatusMessage";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";

export default function ReviewPage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress, setPhase } = useDemolishStore();

  const hasPlan = Boolean(sourceAddress) && executionPlan.length > 0;
  const headingRef = useFocusOnMount<HTMLHeadingElement>(hasPlan);

  useEffect(() => {
    if (!sourceAddress || executionPlan.length === 0) {
      router.replace(`/${network}/analyze`);
    }
  }, [sourceAddress, executionPlan.length, network, router]);

  if (!sourceAddress || executionPlan.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          aria-label="Back to analyze"
          onClick={() => goBackToAnalyze(setPhase, router, network)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mkt-display text-xl font-bold text-white outline-none"
        >
          Review the full plan
        </h1>
        <span className="text-xs text-white/45 ml-auto mkt-mono">
          {sourceAddress.slice(0, 8)}...{sourceAddress.slice(-8)}
        </span>
      </div>

      <StatusMessage
        message={`Plan ready to review: ${executionPlan.length} ${executionPlan.length === 1 ? "step" : "steps"}.`}
      />
      <ReviewView network={network} />
    </div>
  );
}
