"use client";

import { useState, type ReactNode } from "react";
import type { PlannedStep } from "@/types/plan";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { groupStepsByType, STEP_GROUP_LABELS } from "@/lib/plan/group-steps";
import { stepFeeStroops } from "@/lib/plan/review-fees";
import { formatStroops } from "@/lib/api/plan-adapters";
import { FullAddress } from "@/components/ui/full-address";
import { Tabs } from "@/components/ui/tabs";

interface PlanStepListProps {
  steps: PlannedStep[];
  destinationAddress: string | null;
  /** The close goes through the relay account, as the registry `verify()` reads says. */
  viaRelay: boolean;
}

type View = "order" | "type";

const VIEWS = [
  { value: "order", label: "In order" },
  { value: "type", label: "By type" },
] as const;

/**
 * The plan the API built, every step on screen at once: nothing on the page the user consents
 * to is folded away. Steps keep the order the close runs them in; grouping them by type is a
 * second view, never the default.
 */
export default function PlanStepList({ steps, destinationAddress, viaRelay }: PlanStepListProps) {
  const [view, setView] = useState<View>("order");

  // Numbered and keyed by place in the plan, not by the API's `index`, which nothing checks for
  // uniqueness or order.
  const position = new Map(steps.map((s, i) => [s, i + 1]));
  const row = (s: PlannedStep): ReactNode => {
    const fee = stepFeeStroops(s);
    return (
      <li key={position.get(s)} className="flex gap-3 py-3" data-testid="plan-step">
        <span className="mkt-mono w-6 shrink-0 text-right text-xs text-fg-subtle">
          {position.get(s)}.
        </span>
        <StepTypeIcon type={s.type} className="mt-0.5 h-4 w-4 shrink-0 text-accent/70" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white/90">
            {s.title || STEP_GROUP_LABELS[s.type]}
          </p>
          {s.description && <p className="text-xs text-fg-muted">{s.description}</p>}
          {s.type === "MERGE" && destinationAddress && (
            <p className="mt-1 text-xs text-fg-muted">
              Destination:{" "}
              <FullAddress
                value={destinationAddress}
                label="destination address"
                className="text-white/70"
              />
              {viaRelay && " · routed through the shared relay account"}
            </p>
          )}
          <p className="mt-1 text-xs text-fg-subtle">
            {s.operationCount} {s.operationCount === 1 ? "operation" : "operations"} ·{" "}
            {fee === null ? "fee not available" : `fee about ${formatStroops(fee.toString())} XLM`}
          </p>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <Tabs
        label="How the plan is listed"
        items={VIEWS}
        value={view}
        onValueChange={setView}
        size="sm"
      >
        {view === "order" ? (
          <ol className="divide-y divide-white/8">{steps.map(row)}</ol>
        ) : (
          <div className="space-y-4">
            {groupStepsByType(steps).map((g) => (
              <section key={g.type} aria-label={g.label}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
                  {g.label}
                </h3>
                <ul className="divide-y divide-white/8">{g.steps.map(row)}</ul>
              </section>
            ))}
          </div>
        )}
      </Tabs>
    </div>
  );
}
