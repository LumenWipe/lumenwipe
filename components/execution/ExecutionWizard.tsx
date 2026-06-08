"use client";

import { useRef, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useStepExecution } from "@/hooks/useStepExecution";
import { NoConversionPathError } from "@/lib/utils/errors";
import PlanSidebar from "./PlanSidebar";
import StepDetailPanel from "./StepDetailPanel";

interface ExecutionWizardProps {
  network: Network;
}

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");

  const { executionPlan, currentStepIndex, setCurrentStepIndex, setPhase, updateStep, phase } =
    useDemolishStore();

  const { executeStep, progressStatus, buildStepXdr } = useStepExecution();
  const [noPathAsset, setNoPathAsset] = useState<string | null>(null);

  const currentStep = executionPlan[currentStepIndex];
  const allDone =
    executionPlan.length > 0 &&
    executionPlan.every((s) => s.status === "confirmed" || s.status === "skipped");

  // Auto-advance when a step is confirmed
  useEffect(() => {
    if (phase === "STEP_CONFIRMED") {
      if (allDone) {
        setPhase("COMPLETE");
        router.push(`/${network}/complete`);
        return;
      }
      const nextPending = executionPlan.find((s) => s.status === "pending");
      if (nextPending) {
        setCurrentStepIndex(nextPending.index);
        setPhase("STEP_EXECUTING");
      }
    }
  }, [phase, allDone, executionPlan, network, router, setCurrentStepIndex, setPhase]);

  // Pre-build XDR for the current step when it becomes active
  useEffect(() => {
    if (!currentStep || currentStep.txXdr || currentStep.status !== "pending") return;
    setNoPathAsset(null);
    buildStepXdr(currentStep)
      .then((xdr) => updateStep(currentStep.index, { txXdr: xdr }))
      .catch((err) => {
        if (err instanceof NoConversionPathError) {
          setNoPathAsset(currentStep.affectedAsset?.split(":")[0] ?? "token");
        } else {
          updateStep(currentStep.index, {
            error: err instanceof Error ? err.message : "Failed to build transaction",
          });
        }
      });
  }, [currentStep, buildStepXdr, updateStep]);

  async function handleSign() {
    if (!currentStep || !secretKeyRef.current) return;
    const key = secretKeyRef.current;
    secretKeyRef.current = ""; // clear before async to avoid holding it longer than needed
    await executeStep(currentStep, key);
  }

  function handleRetry() {
    if (!currentStep) return;
    updateStep(currentStep.index, { status: "pending", error: null, txXdr: null });
    setPhase("STEP_EXECUTING");
  }

  function handleSendToIssuer() {
    if (!currentStep) return;
    setNoPathAsset(null);
    updateStep(currentStep.index, { fallbackToIssuer: true, txXdr: null });
  }

  function handleSkipStep() {
    if (!currentStep) return;
    setNoPathAsset(null);
    updateStep(currentStep.index, { status: "skipped" });
    const nextPending = executionPlan.find(
      (s) => s.status === "pending" && s.index !== currentStep.index
    );
    if (nextPending) {
      setCurrentStepIndex(nextPending.index);
      setPhase("STEP_EXECUTING");
    } else {
      setPhase("COMPLETE");
      router.push(`/${network}/complete`);
    }
  }

  if (!currentStep) {
    return (
      <div className="text-center py-12 text-white/45 text-sm">
        No execution plan found. Please go back and analyze your account.
      </div>
    );
  }

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-52 shrink-0 hidden md:block">
        <div className="sticky top-20">
          <p className="mkt-eyebrow text-white/45 mb-3">Steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={currentStepIndex} />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0">
        <StepDetailPanel
          step={currentStep}
          network={network}
          secretKeyRef={secretKeyRef as React.MutableRefObject<string>}
          onSign={handleSign}
          onRetry={handleRetry}
          progressStatus={progressStatus}
          noSwapPath={noPathAsset !== null}
          noSwapPathAsset={noPathAsset}
          onSendToIssuer={handleSendToIssuer}
          onSkipStep={handleSkipStep}
        />

        {/* Mobile step list */}
        <div className="md:hidden mt-5">
          <p className="mkt-eyebrow text-white/45 mb-2">All steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={currentStepIndex} />
        </div>
      </div>
    </div>
  );
}
