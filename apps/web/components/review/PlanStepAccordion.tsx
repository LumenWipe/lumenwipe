"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { PlannedStep, StepType } from "@/types/plan";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { groupStepsByType } from "@/lib/plan/group-steps";

interface PlanStepAccordionProps {
  steps: PlannedStep[];
  destinationAddress: string | null;
  mediatorRequired: boolean;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

/**
 * Read-only counterpart to components/plan/PlanAccordion.tsx: that component derives its groups
 * from raw account state to drive pre-plan decisions (asset disposition, claimable-balance
 * remediation) and isn't reusable here - by the time the finalized executionPlan exists, none of
 * that raw decision data survives navigation to /review. This renders the plan the API actually
 * built, grouped by step type, with each step's own API-provided title/description.
 */
export default function PlanStepAccordion({
  steps,
  destinationAddress,
  mediatorRequired,
}: PlanStepAccordionProps) {
  const groups = groupStepsByType(steps);
  const [open, setOpen] = useState<StepType | null>(groups[0]?.type ?? null);

  return (
    <div className="divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10 bg-[hsl(var(--card)/0.6)]">
      {groups.map((g) => {
        const isOpen = open === g.type;
        const totalOps = g.steps.reduce((sum, s) => sum + s.operationCount, 0);

        return (
          <div key={g.type}>
            <button
              onClick={() => setOpen(isOpen ? null : g.type)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.02]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StepTypeIcon type={g.type} className="h-4 w-4 shrink-0 text-stellar/70" />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium transition-colors ${
                      isOpen ? "text-white" : "text-white/80"
                    }`}
                  >
                    {g.label}
                  </span>
                  <span className="block truncate text-xs text-white/45">
                    {g.steps.length} step{g.steps.length === 1 ? "" : "s"} · {totalOps} operation
                    {totalOps === 1 ? "" : "s"}
                  </span>
                </span>
              </span>
              <Plus
                className={`h-4 w-4 shrink-0 text-stellar transition-transform duration-300 ${
                  isOpen ? "rotate-45" : ""
                }`}
              />
            </button>
            <div
              className={`grid transition-all duration-300 ease-out ${
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <div className="space-y-3 px-4 pb-4">
                  {g.steps.map((s) => (
                    <div key={s.index}>
                      <p className="text-xs font-medium text-white/80">{s.title}</p>
                      <p className="text-xs text-white/55">{s.description}</p>
                    </div>
                  ))}
                  {g.type === "MERGE" && destinationAddress && (
                    <p className="text-xs text-white/55">
                      Destination:{" "}
                      <span className="font-mono-address text-white/70">
                        {shortAddr(destinationAddress)}
                      </span>
                      {mediatorRequired && " · routed through the shared exchange mediator"}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
