import { CheckCircle, Clock, AlertCircle, Loader2, ChevronRight } from "lucide-react";
import type { PlannedStep } from "@/types/plan";
import { cn } from "@/lib/utils/cn";
import { StepTypeIcon } from "@/lib/utils/stepIcons";

interface StepCardProps {
  step: PlannedStep;
  isActive?: boolean;
  onClick?: () => void;
}

export default function StepCard({ step, isActive, onClick }: StepCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 p-3 rounded-lg border transition-colors",
        isActive
          ? "border-stellar/50 bg-stellar/5"
          : step.status === "confirmed"
            ? "border-emerald-500/20 bg-emerald-500/5"
            : step.status === "failed"
              ? "border-destructive/30 bg-destructive/5"
              : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]",
        onClick && "cursor-pointer"
      )}
    >
      {/* Status icon */}
      <div className="mt-0.5 shrink-0">
        {step.status === "confirmed" && <CheckCircle className="h-4 w-4 text-emerald-500" />}
        {step.status === "failed" && <AlertCircle className="h-4 w-4 text-destructive" />}
        {(step.status === "signing" || step.status === "submitted") && (
          <Loader2 className="h-4 w-4 text-stellar animate-spin" />
        )}
        {step.status === "pending" && <Clock className="h-4 w-4 text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <StepTypeIcon type={step.type} className="h-3.5 w-3.5 text-stellar/70 shrink-0" />
          <p
            className={cn(
              "text-sm font-medium truncate",
              step.status === "confirmed" ? "text-emerald-400" : "text-white"
            )}
          >
            {step.title}
          </p>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{step.description}</p>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-xs text-muted-foreground/70">
            {step.operationCount} op{step.operationCount !== 1 ? "s" : ""} ·{" "}
            {step.estimatedFeeLumens} XLM fee
          </span>
          {step.txHash && (
            <span className="flex items-center gap-1 text-xs text-emerald-500 font-mono truncate">
              <CheckCircle className="h-3 w-3 shrink-0" />
              {step.txHash.slice(0, 10)}...
            </span>
          )}
        </div>
      </div>

      {isActive && <ChevronRight className="h-4 w-4 text-stellar shrink-0 mt-0.5" />}
    </div>
  );
}
