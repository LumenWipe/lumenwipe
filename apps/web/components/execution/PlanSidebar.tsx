import { CheckCircle, Clock, AlertCircle, Loader2, ChevronRight } from "lucide-react";
import type { PlannedStep } from "@/types/plan";
import { cn } from "@/lib/utils/cn";
import { StepTypeIcon } from "@/lib/utils/stepIcons";

interface PlanSidebarProps {
  steps: PlannedStep[];
  currentIndex: number;
}

export default function PlanSidebar({ steps, currentIndex }: PlanSidebarProps) {
  return (
    <nav className="space-y-1">
      {steps.map((step) => {
        const isActive = step.index === currentIndex;

        return (
          <div
            key={step.index}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              isActive
                ? "bg-stellar/10 border border-stellar/30 text-white"
                : step.status === "confirmed"
                  ? "text-emerald-400/70"
                  : step.status === "failed"
                    ? "text-destructive/70"
                    : "text-white/45"
            )}
          >
            {/* Status icon */}
            <div className="shrink-0">
              {step.status === "confirmed" && (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              )}
              {step.status === "failed" && <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
              {(step.status === "signing" || step.status === "submitted") && (
                <Loader2 className="h-3.5 w-3.5 text-stellar animate-spin" />
              )}
              {step.status === "pending" && (
                <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />
              )}
            </div>

            <span className="flex-1 truncate text-xs flex items-center gap-1.5">
              <StepTypeIcon type={step.type} className="h-3 w-3 shrink-0 opacity-60" />
              {step.title}
            </span>

            {isActive && <ChevronRight className="h-3.5 w-3.5 text-stellar shrink-0" />}
          </div>
        );
      })}
    </nav>
  );
}
