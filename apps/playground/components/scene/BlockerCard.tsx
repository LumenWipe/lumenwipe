import type { ReactNode } from "react";
import { ShieldAlert, Wrench } from "lucide-react";
import { blockerCopy } from "@/lib/error-copy";
import type { StoppedClose } from "@/store/playground";

/**
 * Shown when the close stopped before building: the LumenWipe API asked for a decision the demo
 * has no answer for, named by the API's own id, or reported a blocker, in plain language. A
 * blocker the session's plan can clear gets a "Resolve it" button.
 */
export default function BlockerCard({
  message,
  stop,
  onResolve,
  children,
}: {
  message: string;
  stop: StoppedClose;
  onResolve: (blocker: string) => void;
  /** Shown after the message, such as the replay code. */
  children?: ReactNode;
}) {
  const title =
    stop.blockers.length > 0
      ? "Blocked: the account cannot be merged yet"
      : "Blocked: a decision this demo cannot make";
  return (
    <div
      role="alert"
      aria-labelledby="blocker-card-title"
      className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75"
    >
      <p id="blocker-card-title" className="mb-2 flex items-start gap-2 font-medium text-white/85">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-value" />
        <span>{title}</span>
      </p>
      <p className="mb-2 text-xs leading-relaxed">
        {message}
        {children}
      </p>
      {stop.decisionIds.length > 0 && (
        <ul aria-label="Unanswered decisions" className="space-y-1">
          {stop.decisionIds.map((id) => (
            <li key={id} className="break-all mkt-mono text-[10px] text-white/60">
              {id}
            </li>
          ))}
        </ul>
      )}
      {stop.blockers.length > 0 && (
        <ul aria-label="Blockers" className="space-y-2">
          {stop.blockers.map((code) => (
            <li key={code} className="text-xs leading-relaxed">
              {blockerCopy(code)}
              {stop.resolvable.includes(code) && (
                <button
                  onClick={() => onResolve(code)}
                  className="mt-1.5 flex items-center gap-1.5 rounded border border-value/40 px-2.5 py-1 text-xs text-white/85 hover:bg-[hsl(var(--value)/0.12)]"
                >
                  <Wrench className="h-3 w-3" />
                  Resolve it
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
