import { AlertOctagon, AlertTriangle, ExternalLink } from "lucide-react";
import type { PlanBlocker } from "@/types/plan";
import { Callout } from "@/components/ui/callout";

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

  const Icon = blocking ? AlertOctagon : AlertTriangle;
  const tone = blocking ? "danger" : "warning";
  const bullet = blocking ? "text-danger-fg" : "text-warning";

  return (
    <Callout
      tone={tone}
      announce={false}
      icon={<Icon className="h-4 w-4" />}
      title={
        <h2 className="text-sm font-semibold">
          {blocking ? "Cannot proceed - blockers found" : "Needs verification"}
        </h2>
      }
      className="p-4"
    >
      <ul className="space-y-2">
        {blockers.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-fg-muted">
            <span className={`${bullet} mt-0.5`}>•</span>
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
    </Callout>
  );
}
