"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { goBackToAnalyze } from "@/lib/plan/confirm-plan";
import { routeForPhase } from "@/lib/plan/route-for-phase";
import ReviewView from "@/components/review/ReviewView";
import { Button } from "@/components/ui/button";
import StatusMessage from "@/components/a11y/StatusMessage";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";

export default function ReviewPage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress, phase, setPhase } = useDemolishStore();

  const hasPlan = Boolean(sourceAddress) && executionPlan.length > 0;
  const route = hasPlan ? routeForPhase(phase) : "analyze";
  const headingRef = useFocusOnMount<HTMLHeadingElement>(route === "review");

  // Back from /execute lands here with steps already signed: only a close still waiting for its
  // confirmation may be reviewed, so a confirmed one can never be confirmed and planned again.
  useEffect(() => {
    if (route !== "review") router.replace(`/${network}/${route}`);
  }, [route, network, router]);

  if (!sourceAddress || route !== "review") return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back to analyze"
          onClick={() => goBackToAnalyze(setPhase, router, network)}
          icon={<ArrowLeft className="h-4 w-4" />}
        />
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mkt-display text-xl font-bold text-white outline-none"
        >
          Review the full plan
        </h1>
        <span className="text-xs text-fg-subtle ml-auto mkt-mono">
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
