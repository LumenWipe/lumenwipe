import type { ReactElement } from "react";
import { Ban, Check, Circle, Dot, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type StepState = "pending" | "active" | "done" | "failed" | "blocked";

const STATE: Record<StepState, { text: string; icon: LucideIcon; className: string }> = {
  pending: { text: "Pending", icon: Circle, className: "text-fg-subtle" },
  active: { text: "Current", icon: Dot, className: "text-accent" },
  done: { text: "Done", icon: Check, className: "text-success" },
  failed: { text: "Failed", icon: X, className: "text-danger-fg" },
  blocked: { text: "Blocked", icon: Ban, className: "text-warning" },
};

export const stepperSurface = "rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5";

interface StepperProps {
  steps: readonly string[];
  /** Index of the one current step: earlier steps read as done, later ones as pending. */
  current: number;
  status?: Exclude<StepState, "pending">;
  className?: string;
}

/** Below `md` the list gives way to one line, so `aria-current` is exposed by the list alone. */
export function Stepper({
  steps,
  current,
  status = "active",
  className,
}: StepperProps): ReactElement | null {
  if (steps.length === 0) return null;
  const index = Math.min(Math.max(current, 0), steps.length - 1);

  return (
    <div className={cn(stepperSurface, "text-sm", className)}>
      <ol className="hidden items-center gap-4 md:flex">
        {steps.map((step, i) => {
          const state = i < index ? "done" : i > index ? "pending" : status;
          const { text, icon: Icon, className: tone } = STATE[state];
          return (
            <li
              key={step}
              aria-current={i === index ? "step" : undefined}
              className={cn("flex items-center gap-1.5", tone)}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span>{step}</span>
              <span className="sr-only">({text})</span>
            </li>
          );
        })}
      </ol>
      <p className={cn("md:hidden", STATE[status].className)}>
        Step {index + 1} of {steps.length}: {steps[index]}
        {status !== "active" && ` (${STATE[status].text})`}
      </p>
    </div>
  );
}
