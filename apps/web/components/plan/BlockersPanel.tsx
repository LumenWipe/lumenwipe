import { AlertOctagon, ExternalLink } from "lucide-react";
import type { PlanBlocker } from "@/types/plan";

interface BlockersPanelProps {
  blockers: PlanBlocker[];
}

export default function BlockersPanel({ blockers }: BlockersPanelProps) {
  if (blockers.length === 0) return null;

  return (
    <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertOctagon className="h-4 w-4 text-destructive shrink-0" />
        <h3 className="text-sm font-semibold text-destructive">Cannot proceed - blockers found</h3>
      </div>
      <ul className="space-y-2">
        {blockers.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
            <span className="text-destructive mt-0.5">•</span>
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
