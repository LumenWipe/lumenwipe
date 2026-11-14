"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, Flame, Info, PlusCircle } from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";
import { txExplorerUrl } from "@/lib/explorer";

const KIND_META = {
  mess: { Icon: PlusCircle, className: "text-value" },
  demolish: { Icon: Flame, className: "text-stellar" },
  info: { Icon: Info, className: "text-subtle" },
} as const;

export default function TxLogPanel() {
  const log = usePlaygroundStore((s) => s.log);
  // Below the lg breakpoint the log starts collapsed under the controls; from it, the toggle is
  // not rendered and the list always shows.
  const [open, setOpen] = useState(false);
  if (log.length === 0) return null;

  return (
    <div className="mkt-panel relative rounded-lg p-4">
      <p className="mkt-eyebrow mb-3 hidden text-white/50 lg:block">On-chain activity</p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="tx-log"
        onClick={() => setOpen((o) => !o)}
        className="mkt-eyebrow flex min-h-6 w-full items-center justify-between text-white/70 lg:hidden"
      >
        On-chain activity ({log.length})
        <ChevronDown aria-hidden className={`h-4 w-4 ${open ? "rotate-180" : ""}`} />
      </button>
      <ul
        id="tx-log"
        aria-label="On-chain activity"
        className={`${open ? "mt-3" : "hidden"} max-h-64 space-y-1.5 overflow-y-auto pr-1 lg:mt-0 lg:block`}
      >
        {[...log].reverse().map((entry) => {
          const { Icon, className } = KIND_META[entry.kind];
          return (
            <li key={entry.id} className="flex items-center gap-2 text-xs text-white/70">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} />
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.txHash && (
                <a
                  href={txExplorerUrl(entry.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex shrink-0 items-center gap-1 mkt-mono text-[10px] text-stellar hover:underline"
                >
                  {entry.txHash.slice(0, 8)}…
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
