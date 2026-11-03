"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { NOTHING_SAVED, readDecisions, savedSource } from "@/lib/session/decision-snapshot";
import { REVIEW_RESTORED, reviewResetNotice } from "@/lib/utils/user-error";
import { useKeepDecisions } from "@/hooks/useKeepDecisions";
import { goBackToAnalyze } from "@/lib/plan/confirm-plan";
import { routeForPhase } from "@/lib/journey/route-for-phase";
import ReviewView from "@/components/review/ReviewView";
import { Button } from "@/components/ui/button";
import StatusMessage from "@/components/a11y/StatusMessage";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";

export default function ReviewPage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress, phase, setPhase, setReloadNotice } = useDemolishStore();
  const networkReady = useNetworkStore((s) => s.network) === network;

  const hasPlan = Boolean(sourceAddress) && executionPlan.length > 0;
  const route = hasPlan ? routeForPhase(phase) : "analyze";
  const headingRef = useFocusOnMount<HTMLHeadingElement>(route === "review");

  // Back from /execute lands here with steps already signed: only a close still waiting for its
  // confirmation may be reviewed, so a confirmed one can never be confirmed and planned again.
  // A store holding no account is one a reload emptied: its plan is built again through analyze,
  // the one path a plan is made by, from this tab's saved choices, and reviewed again.
  useEffect(() => {
    if (route === "review") return;
    if (sourceAddress) {
      router.replace(`/${network}/${route}`);
      return;
    }
    if (!networkReady) return;
    const saved = savedSource(network);
    if (saved.kind !== "found") {
      setReloadNotice(reviewResetNotice(saved.kind === "failed" ? saved.reason : NOTHING_SAVED));
      router.replace(`/${network}`);
      return;
    }
    const { source } = saved;
    const read = readDecisions(network, source);
    setReloadNotice(
      read.kind === "restored"
        ? REVIEW_RESTORED
        : reviewResetNotice(read.kind === "failed" ? read.reason : NOTHING_SAVED)
    );
    router.replace(`/${network}/analyze?source=${encodeURIComponent(source)}`);
  }, [route, network, router, sourceAddress, networkReady, setReloadNotice]);

  useKeepDecisions(network, route === "review" ? sourceAddress : null);

  if (!sourceAddress || route !== "review") return <ReviewSkeleton />;

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

function ReviewSkeleton() {
  return (
    <div role="status" aria-busy="true" className="max-w-3xl mx-auto px-4 py-8">
      <span className="sr-only">Loading the review</span>
      <div aria-hidden="true" className="animate-pulse space-y-4">
        <div className="h-6 w-48 rounded bg-white/10" />
        <div className="h-24 rounded-lg bg-white/[0.06]" />
        <div className="h-40 rounded-lg bg-white/[0.06]" />
      </div>
    </div>
  );
}
