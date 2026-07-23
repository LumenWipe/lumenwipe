"use client";

import { ExternalLink, Flame, Info, PlusCircle } from "lucide-react";
import { SV_EXPLORER_BASE } from "@/config/networks";
import { usePlaygroundStore } from "@/store/playground";

const KIND_META = {
  mess: { Icon: PlusCircle, className: "text-value" },
  demolish: { Icon: Flame, className: "text-stellar" },
  info: { Icon: Info, className: "text-white/40" },
} as const;

export default function TxLogPanel() {
  const log = usePlaygroundStore((s) => s.log);
  if (log.length === 0) return null;

  return (
    <div className="mkt-panel relative rounded-lg p-4">
      <p className="mkt-eyebrow mb-3 text-white/50">On-chain activity</p>
      <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
        {[...log].reverse().map((entry) => {
          const { Icon, className } = KIND_META[entry.kind];
          return (
            <li key={entry.id} className="flex items-center gap-2 text-xs text-white/70">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${className}`} />
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.txHash && (
                <a
                  href={`${SV_EXPLORER_BASE.testnet}/tx/${entry.txHash}`}
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
