"use client";

import { Check, Loader2, X } from "lucide-react";
import { usePlaygroundExecution } from "@/hooks/usePlaygroundExecution";
import { usePlaygroundStore } from "@/store/playground";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import OrbitalScene from "./OrbitalScene";
import PlaygroundControls from "./PlaygroundControls";
import TxLogPanel from "./TxLogPanel";

function PlanSteps() {
  const executionPlan = usePlaygroundStore((s) => s.executionPlan);
  const phase = usePlaygroundStore((s) => s.phase);
  if (
    executionPlan.length === 0 ||
    (phase !== "DIRTY" && phase !== "DEMOLISHING" && phase !== "COMPLETE" && phase !== "ERROR")
  ) {
    return null;
  }

  return (
    <div className="mkt-panel relative rounded-lg p-4">
      <p className="mkt-eyebrow mb-3 text-white/50">Demolition plan</p>
      <ul className="space-y-1.5">
        {executionPlan.map((step) => (
          <li key={step.index} className="flex items-center gap-2 text-xs text-white/70">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              {step.status === "confirmed" ? (
                <Check className="h-3.5 w-3.5 text-stellar" />
              ) : step.status === "failed" ? (
                <X className="h-3.5 w-3.5 text-destructive" />
              ) : step.status === "signing" || step.status === "submitted" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-value" />
              ) : (
                <StepTypeIcon type={step.type} className="h-3.5 w-3.5 text-white/30" />
              )}
            </span>
            <span className={step.status === "confirmed" ? "text-white/40 line-through" : ""}>
              {step.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PlaygroundClient() {
  const { start, demolish, progressStatus } = usePlaygroundExecution();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="mkt-panel relative overflow-hidden rounded-lg p-4 sm:p-8">
        <div aria-hidden className="absolute inset-0 mkt-dots opacity-60" />
        <OrbitalScene />
      </div>

      <div className="flex flex-col gap-4">
        <PlaygroundControls start={start} demolish={demolish} progressStatus={progressStatus} />
        <PlanSteps />
        <TxLogPanel />
      </div>
    </div>
  );
}
