"use client";

import { AlertTriangle, Loader2, TimerReset } from "lucide-react";
import type { SessionCountdown } from "@/hooks/useSessionCountdown";

const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/** What the session's end does, said where the countdown is shown. */
export const TIME_UP_COPY =
  "Time is up: the demo account will be reclaimed. It takes no more setup steps, and you can still close it here.";

export const WARNING_COPY =
  "Five minutes left. When the countdown reaches zero, the demo account will be reclaimed.";

/** The countdown in the panel's header. */
export function CountdownBadge({ remaining }: { remaining: number }) {
  return (
    <span className="flex items-center gap-1 mkt-mono text-[11px] text-subtle">
      <TimerReset className="h-3 w-3" aria-hidden />
      {remaining > 0 ? `Session ends in ${clock(remaining)}` : "Session ended"}
    </span>
  );
}

/** The five-minute warning with the one extension, or what the end of the countdown means. */
export function CountdownNotice({ countdown }: { countdown: SessionCountdown }) {
  const { warning, timeUp, extended, extending, extendError, extend } = countdown;
  if (!warning && !timeUp) return null;
  return (
    <div className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/80">
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-value" aria-hidden />
        <span>{timeUp ? TIME_UP_COPY : WARNING_COPY}</span>
      </p>
      {warning && !extended && (
        <button
          type="button"
          onClick={extend}
          disabled={extending}
          className="mt-3 flex items-center gap-2 rounded-md border border-value/40 px-3 py-1.5 text-xs text-value transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {extending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Add 30 minutes (once)
        </button>
      )}
      {extendError && (
        <p role="alert" className="mt-2 text-xs text-white/80">
          {extendError}
        </p>
      )}
    </div>
  );
}
