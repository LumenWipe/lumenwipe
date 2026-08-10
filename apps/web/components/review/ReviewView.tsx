"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { saveSession } from "@/lib/session/store";
import { formatXlm } from "@/lib/utils/amounts";
import PlanSidebar from "@/components/execution/PlanSidebar";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";

interface ReviewViewProps {
  network: Network;
}

export default function ReviewView({ network }: ReviewViewProps) {
  const router = useRouter();
  const {
    accountState,
    executionPlan,
    destinationAddress,
    mediatorRequired,
    sourceAddress,
    memo,
    memoType,
    mediatorPublicKey,
    sessionId,
    initSession,
    setPhase,
  } = useDemolishStore();

  const [confirming, setConfirming] = useState(false);

  const totalFee = executionPlan
    .reduce((sum, step) => sum + parseFloat(step.estimatedFeeLumens), 0)
    .toFixed(7);

  // The only caller allowed to transition PREFLIGHT_COMPLETE -> STEP_EXECUTING. Nothing
  // is persisted until this fires, so leaving this page without confirming (closing the
  // tab, navigating away) never leaves a resumable session behind.
  async function handleConfirm() {
    if (!sourceAddress || !destinationAddress) return;
    setConfirming(true);

    if (!sessionId) initSession();
    const id = useDemolishStore.getState().sessionId;
    if (id) {
      const now = new Date().toISOString();
      await saveSession({
        id,
        network,
        sourceAddress,
        destinationAddress,
        memo,
        memoType,
        mediatorPublicKey,
        completedSteps: [],
        currentStepIndex: 0,
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      });
    }

    setPhase("STEP_EXECUTING");
    router.push(`/${network}/execute`);
  }

  return (
    <div className="space-y-5">
      {accountState && (
        <AccountSummaryCard
          account={accountState}
          destinationAddress={destinationAddress}
          totalFee={totalFee}
        />
      )}

      <div className="mkt-panel rounded-2xl">
        <div className="border-b border-white/10 px-4 py-3">
          <h3 className="mkt-eyebrow text-white/45">Full plan · {executionPlan.length} step(s)</h3>
        </div>
        <div className="p-3">
          <PlanSidebar steps={executionPlan} currentIndex={-1} />
        </div>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-white/60">
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-stellar" />
        <span>
          Every transaction above is verified against your own choices before it is signed. Once
          you proceed, you&apos;ll sign each step on the next screen.
        </span>
      </div>

      <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm">
        <p className="font-semibold text-destructive mb-1">This plan is permanent and irreversible.</p>
        <p className="text-white/60">
          The account will be removed from the Stellar ledger and its balance sent to{" "}
          <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
          {mediatorRequired ? " through the exchange mediator." : "."}
        </p>
      </div>

      <button
        onClick={handleConfirm}
        disabled={confirming || executionPlan.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-stellar px-4 py-3 font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
      >
        {confirming ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing...
          </>
        ) : (
          <>
            I understand this plan and want to proceed
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>

      {!accountState && (
        <p className="flex items-center gap-1.5 text-xs text-white/45">
          <AlertTriangle className="h-3.5 w-3.5" />
          Account summary unavailable — the plan below is still accurate.
        </p>
      )}

      <p className="text-center text-xs text-white/45">{formatXlm(totalFee)} in estimated network fees</p>
    </div>
  );
}
