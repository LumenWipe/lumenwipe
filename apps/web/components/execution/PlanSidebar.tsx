import { CheckCircle, Clock, AlertCircle, Loader2, ChevronRight, ExternalLink } from "lucide-react";
import type { PlannedStep } from "@/types/plan";
import { explorerTxUrl, type Network } from "@/config/networks";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils/cn";
import { shortHash } from "@/lib/utils/short-id";
import { StepTypeIcon } from "@/lib/utils/stepIcons";

interface PlanSidebarProps {
  steps: PlannedStep[];
  /** The plan index of the step the close is on, or -1 when none is. */
  currentIndex: number;
  /** Whether a run of the close is going, so a step in flight is being worked on now. */
  running: boolean;
  /** The network the hashes are on, for their explorer links. */
  network: Network;
}

/** The status a row reads out, in words, so it never depends on its icon or colour. */
export function stepStatusText(step: PlannedStep, running: boolean): string {
  switch (step.status) {
    case "confirmed":
      return "Confirmed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "signing":
      return running ? "Signing" : "Not signed";
    case "submitted":
      // Sent and not settled: it may still land, so it is never called failed.
      return running ? "Confirming" : "Sent, not confirmed";
    default:
      return "Waiting";
  }
}

/** A confirmed transaction's hash, to check on the network independently of this screen. */
function ConfirmedHash({ hash, network }: { hash: string; network: Network }) {
  const short = shortHash(hash);
  return (
    <span className="flex items-center gap-1 text-caption">
      <a
        href={explorerTxUrl(network, hash)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View transaction ${short} on Stellar Expert (opens in a new tab)`}
        className="flex items-center gap-1 font-mono-address text-accent hover:underline"
      >
        {short}
        <ExternalLink aria-hidden="true" className="h-3 w-3" />
      </a>
      <CopyButton value={hash} label={`transaction hash ${short}`} visibleFeedback />
    </span>
  );
}

export default function PlanSidebar({ steps, currentIndex, running, network }: PlanSidebarProps) {
  return (
    <ol aria-label="Plan steps" className="space-y-1">
      {steps.map((step) => {
        const isActive = step.index === currentIndex;
        const inFlight = running && (step.status === "signing" || step.status === "submitted");

        return (
          <li
            key={step.index}
            aria-current={isActive ? "step" : undefined}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              isActive
                ? "bg-accent/10 border border-accent/30 text-white"
                : step.status === "confirmed"
                  ? "text-success/70"
                  : step.status === "failed"
                    ? "text-danger-fg/70"
                    : "text-fg-subtle"
            )}
          >
            {/* Decorative: the status is in words beside it. */}
            <div className="shrink-0" aria-hidden="true">
              {step.status === "confirmed" && <CheckCircle className="h-3.5 w-3.5 text-success" />}
              {step.status === "failed" && <AlertCircle className="h-3.5 w-3.5 text-danger-fg" />}
              {inFlight && <Loader2 className="h-3.5 w-3.5 text-accent motion-safe:animate-spin" />}
              {!inFlight && step.status !== "confirmed" && step.status !== "failed" && (
                <Clock className="h-3.5 w-3.5 text-fg-muted/50" />
              )}
            </div>

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs flex items-center gap-1.5">
                <StepTypeIcon type={step.type} className="h-3 w-3 shrink-0 opacity-60" />
                {step.title}
              </span>
              <span className="text-caption text-fg-subtle">{stepStatusText(step, running)}</span>
              {/* Kept whatever happens later in the close: a confirmed transaction stays on the
                  ledger, and this is where it can be checked from. */}
              {step.status === "confirmed" && step.txHash && (
                <ConfirmedHash hash={step.txHash} network={network} />
              )}
            </span>

            {isActive && (
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-accent shrink-0" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
