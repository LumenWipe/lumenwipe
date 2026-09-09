"use client";

import { Clock, ShieldOff } from "lucide-react";
import type { Allowance } from "@/types/allowance";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import { formatTokenAmount } from "@/lib/utils/token-amounts";

interface AllowanceRowProps {
  allowance: Allowance;
  onRevoke: (allowance: Allowance) => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export default function AllowanceRow({ allowance, onRevoke }: AllowanceRowProps) {
  const tokenLabel = allowance.tokenSymbol ?? shortAddress(allowance.token);
  const protocolLabel = allowance.spenderProtocol
    ? PROTOCOL_LABELS[allowance.spenderProtocol]
    : null;
  const amountLabel = formatTokenAmount(allowance.amount, allowance.tokenDecimals);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-white" title={allowance.token}>
            {tokenLabel}
          </span>
          <span className="text-white/30">→</span>
          <span className="font-mono-address text-xs text-white/70" title={allowance.spender}>
            {shortAddress(allowance.spender)}
          </span>
          {protocolLabel && (
            <span className="rounded-full border border-stellar/30 bg-stellar/10 px-2 py-0.5 text-[0.65rem] font-medium text-stellar">
              {protocolLabel}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
          <span>
            <span className="text-white/70">{amountLabel}</span> approved
          </span>
          {allowance.expirationLedger !== null ? (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> expires at ledger {allowance.expirationLedger}
            </span>
          ) : (
            <span className="text-white/30">expiration unknown</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(allowance)}
        className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20"
      >
        <ShieldOff className="h-3.5 w-3.5" /> Revoke
      </button>
    </div>
  );
}
