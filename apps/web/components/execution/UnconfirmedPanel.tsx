"use client";

import { Clock } from "lucide-react";
import { STILL_UNCONFIRMED_NOTICE, UNCONFIRMED_NOTICE } from "@/lib/utils/user-error";

interface UnconfirmedPanelProps {
  hash: string;
  stillUnconfirmed: boolean;
  onCheck: () => void;
}

/** A transaction whose outcome is unknown: not failed, not done, and nothing to sign or retry. */
export default function UnconfirmedPanel({
  hash,
  stillUnconfirmed,
  onCheck,
}: UnconfirmedPanelProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="unconfirmed-panel">
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 text-sm text-white/70"
      >
        <Clock className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
        <span>{stillUnconfirmed ? STILL_UNCONFIRMED_NOTICE : UNCONFIRMED_NOTICE}</span>
      </div>
      <p className="text-xs text-fg-subtle">
        Transaction hash: <span className="font-mono break-all text-white/70">{hash}</span>
      </p>
      <button
        onClick={onCheck}
        className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 transition-all"
      >
        Check again
      </button>
    </div>
  );
}
