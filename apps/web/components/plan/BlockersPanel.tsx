import { AlertOctagon, AlertTriangle, ExternalLink } from "lucide-react";
import type { PlanBlocker } from "@/types/plan";

interface BlockersPanelProps {
  blockers: PlanBlocker[];
  /** Whether anything in `blockers` actually stops the close (hardBlockersOf(blockers).length >
   *  0 at the call site). `blockers` can also carry non-trapping codes with no card of their
   *  own (resolvable-blockers.ts's NON_BLOCKING_ELSEWHERE) - rendering those under "Cannot
   *  proceed" would tell the user execution is blocked when it is not. */
  blocking: boolean;
}

export default function BlockersPanel({ blockers, blocking }: BlockersPanelProps) {
  if (blockers.length === 0) return null;

  const theme = blocking
    ? {
        container: "bg-destructive/10 border-destructive/30",
        icon: <AlertOctagon className="h-4 w-4 text-destructive shrink-0" />,
        heading: "text-destructive",
        headingText: "Cannot proceed - blockers found",
        bullet: "text-destructive",
      }
    : {
        container: "bg-amber-500/[0.06] border-amber-500/30",
        icon: <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />,
        heading: "text-amber-300",
        headingText: "Needs verification",
        bullet: "text-amber-400",
      };

  return (
    <div className={`border rounded-xl p-4 ${theme.container}`}>
      <div className="flex items-center gap-2 mb-3">
        {theme.icon}
        <h3 className={`text-sm font-semibold ${theme.heading}`}>{theme.headingText}</h3>
      </div>
      <ul className="space-y-2">
        {blockers.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
            <span className={`${theme.bullet} mt-0.5`}>•</span>
            <span>
              {b.message}
              {b.helpUrl && (
                <a
                  href={b.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-0.5 text-stellar hover:underline"
                >
                  Learn more <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
