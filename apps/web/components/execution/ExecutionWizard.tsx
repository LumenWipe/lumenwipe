"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useStepExecution } from "@/hooks/useStepExecution";
import {
  NoConversionPathError,
  FastPathUnavailableError,
  AssetRouteLostError,
} from "@/lib/utils/errors";
import { buildPlan } from "@/lib/stellar/tx-builder";
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
  const [routeLostAsset, setRouteLostAsset] = useState<{ asset: string; code: string } | null>(
    null
  );
  const [keyEntered, setKeyEntered] = useState(false);

  const forgetKey = useCallback(() => {
    secretKeyRef.current = "";
    setKeyEntered(false);
  }, []);

  // Wipe the key from memory when the wizard unmounts (navigation away).
  useEffect(
    () => () => {
      secretKeyRef.current = "";
    },
    []
  );

  // Wipe the key from memory once the session reaches a terminal phase.
  useEffect(() => {
    if (phase === "COMPLETE" || phase === "ABORTED") {
      secretKeyRef.current = "";
      setKeyEntered(false);
    }
  }, [phase]);

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
    setRouteLostAsset(null);
    buildStepXdr(currentStep)
      .then((xdr) => updateStep(currentStep.index, { txXdr: xdr }))
      .catch((err) => {
        if (err instanceof AssetRouteLostError) {
          // The fused close re-quotes "convert" assets at build time. A route that
          // existed at analyze can vanish before signing; rather than degrading the
          // single tx, ask the user to re-decide this asset to "issuer" and rebuild.
          setRouteLostAsset({ asset: err.asset, code: err.assetCode });
        } else if (err instanceof NoConversionPathError) {
          setNoPathAsset(currentStep.affectedAsset?.split(":")[0] ?? "token");
        } else if (err instanceof FastPathUnavailableError) {
          // The fused single-step close cannot resolve a clean conversion path.
          // Degrade to the stepwise plan, where per-asset handling (issuer
          // fallback, skip) is available, and restart from the first step.
          const account = useDemolishStore.getState().accountState;
          const mediatorRequired = useDemolishStore.getState().mediatorRequired;
          if (account) {
            const { steps } = buildPlan(account, mediatorRequired);
            useDemolishStore.getState().setPlan(steps);
            setCurrentStepIndex(0);
            setPhase("STEP_EXECUTING");
          }
        } else {
          updateStep(currentStep.index, {
            error: err instanceof Error ? err.message : "Failed to build transaction",
          });
        }
      });
  }, [currentStep, buildStepXdr, updateStep, setCurrentStepIndex, setPhase]);

  async function handleSign() {
    if (!currentStep || !secretKeyRef.current) return;
    // The key is held for the whole session and wiped on terminal phase,
    // unmount, or an explicit "Forget key" action - never per step.
    await executeStep(currentStep, secretKeyRef.current);
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

  function handleReturnRouteLostAsset() {
    if (!currentStep || !routeLostAsset) return;
    // Re-decide this asset to "issuer" so the rebuilt fused close sends it back
    // rather than swapping it, then re-trigger the pre-build effect by clearing
    // the step's txXdr/error and setting it back to pending. The single tx is
    // preserved - we rebuild it, we do not degrade to the stepwise plan.
    useDemolishStore.getState().setAssetDisposition(routeLostAsset.asset, "issuer");
    setRouteLostAsset(null);
    updateStep(currentStep.index, { status: "pending", error: null, txXdr: null });
    setPhase("STEP_EXECUTING");
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
          keyEntered={keyEntered}
          onKeyEntered={(valid: boolean) => setKeyEntered(valid)}
          onForgetKey={forgetKey}
          onSign={handleSign}
          onRetry={handleRetry}
          progressStatus={progressStatus}
          noSwapPath={noPathAsset !== null}
          noSwapPathAsset={noPathAsset}
          onSendToIssuer={handleSendToIssuer}
          onSkipStep={handleSkipStep}
          routeLostAsset={routeLostAsset?.code ?? null}
          onReturnRouteLostAsset={handleReturnRouteLostAsset}
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
