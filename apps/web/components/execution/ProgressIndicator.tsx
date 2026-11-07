import { Spinner } from "@/components/ui/spinner";
import { stepperSurface } from "@/components/ui/stepper";
import { formatElapsed, STILL_WAITING } from "@/lib/execution/progress";
import { cn } from "@/lib/utils/cn";

interface ProgressIndicatorProps {
  /** Which transaction is in flight and what it waits on. */
  line: string;
  /** The wait has gone on long enough to say the close is still going. */
  stalled: boolean;
  /** Seconds on the current wait. */
  elapsedSeconds: number;
  /** Show the elapsed time from the start of the wait, not only once it stalls. */
  showTimer?: boolean;
}

export default function ProgressIndicator({
  line,
  stalled,
  elapsedSeconds,
  showTimer = false,
}: ProgressIndicatorProps) {
  return (
    <div className={cn(stepperSurface, "flex items-start gap-2.5 text-sm text-white/60")}>
      <Spinner label="In progress" className="mt-0.5 shrink-0" />
      {/* The wizard's status region already carries the line and the stall notice for assistive
          technology; the timer is left out of it so it is not read out every second. */}
      <span aria-hidden="true" className="flex flex-col gap-1">
        <span>{line}</span>
        {(stalled || showTimer) && (
          <span className="text-xs text-fg-subtle">
            {stalled ? `${STILL_WAITING} ` : ""}
            <span className="font-mono tabular-nums">{formatElapsed(elapsedSeconds)}</span>
          </span>
        )}
      </span>
    </div>
  );
}
