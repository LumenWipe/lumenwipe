import { AlertOctagon, AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import type { PlanBlocker } from "@/types/plan";
import { Callout } from "@/components/ui/callout";
import { isVerifiedOnChain } from "@/lib/plan/resolvable-blockers";

interface BlockersPanelProps {
  blockers: PlanBlocker[];
  /** Whether anything in `blockers` actually stops the close (hardBlockersOf(blockers).length >
   *  0 at the call site). `blockers` can also carry non-trapping codes with no card of their
   *  own (resolvable-blockers.ts's NON_BLOCKING_ELSEWHERE) - rendering those under "Cannot
   *  proceed" would tell the user execution is blocked when it is not. */
  blocking: boolean;
}

export default function BlockersPanel({ blockers, blocking }: BlockersPanelProps) {
  const verified = blockers.filter(isVerifiedOnChain);
  const others = blockers.filter((b) => !isVerifiedOnChain(b));
  if (verified.length === 0 && others.length === 0) return null;

  return (
    <div className="space-y-3">
      {others.length > 0 && <WarningsCallout blockers={others} blocking={blocking} />}
      {verified.length > 0 && <VerifiedCallout blockers={verified} />}
    </div>
  );
}

function WarningsCallout({ blockers, blocking }: BlockersPanelProps) {
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
                  className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
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

function VerifiedCallout({ blockers }: { blockers: PlanBlocker[] }) {
  const helpUrl = blockers.find((b) => b.helpUrl)?.helpUrl;

  return (
    <Callout
      tone="success"
      announce={false}
      icon={<ShieldCheck className="h-4 w-4" />}
      title={<h2 className="text-sm font-semibold">Verified on-chain</h2>}
      className="p-4"
    >
      <div className="space-y-2 text-sm text-fg-muted">
        {blockers.map((b, i) => (
          <p key={i}>{b.message}</p>
        ))}
        <details className="text-xs">
          <summary className="cursor-pointer text-accent hover:underline">Learn more</summary>
          <p className="mt-1">
            This check covers the DeFi protocols LumenWipe recognizes today. To look for anything
            else this account holds, review it on an explorer.
            {helpUrl && (
              <a
                href={helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                Open in explorer <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </details>
      </div>
    </Callout>
  );
}
