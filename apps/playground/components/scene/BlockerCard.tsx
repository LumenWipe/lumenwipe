import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

/**
 * Shown when the close stopped before building because the LumenWipe API asked for a decision the
 * demo has no answer for. Names each decision by the API's own id, so the stop can be reported
 * and reproduced, instead of a generic failure.
 */
export default function BlockerCard({
  message,
  decisionIds,
  children,
}: {
  message: string;
  decisionIds: readonly string[];
  /** Shown after the message, such as the replay code. */
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      aria-labelledby="blocker-card-title"
      className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75"
    >
      <p id="blocker-card-title" className="mb-2 flex items-start gap-2 font-medium text-white/85">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-value" />
        <span>Blocked: a decision this demo cannot make</span>
      </p>
      <p className="mb-2 text-xs leading-relaxed">
        {message}
        {children}
      </p>
      {decisionIds.length > 0 && (
        <ul aria-label="Unanswered decisions" className="space-y-1">
          {decisionIds.map((id) => (
            <li key={id} className="break-all mkt-mono text-[10px] text-white/60">
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
