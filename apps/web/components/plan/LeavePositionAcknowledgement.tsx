import { AlertTriangle } from "lucide-react";
import type { LeavablePosition } from "@/lib/api/plan-adapters";

interface LeavePositionAcknowledgementProps {
  position: LeavablePosition;
  leftBehind: boolean;
  onLeftBehindChange: (leftBehind: boolean) => void;
}

/**
 * Shown for a DeFi position whose exit cannot be built. The merge is refused while it is open,
 * so the user either closes it in the protocol and analyzes again, or states here that they
 * choose to leave it with this address. The answer travels to the API
 * (positionsLeftBehindToDecisions), which honours it only while the exit still cannot be built.
 */
export default function LeavePositionAcknowledgement({
  position,
  leftBehind,
  onLeftBehindChange,
}: LeavePositionAcknowledgementProps) {
  const where = `${position.protocol} ${position.contract.slice(0, 4)}…${position.contract.slice(-4)}`;
  const value = position.usdValue === null ? "value unknown" : `about $${position.usdValue}`;
  return (
    <div className="space-y-2 rounded-lg border border-warning/20 bg-warning/10 p-3">
      <div className="flex items-start gap-2 text-sm text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          LumenWipe cannot exit the {where} position ({value}).
        </span>
      </div>
      {position.reason && <p className="text-xs text-white/60">{position.reason}</p>}
      <p className="text-xs text-white/60">
        To withdraw it instead, close it through {position.protocol} and analyze this account again.
      </p>
      <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
        <input
          type="checkbox"
          checked={leftBehind}
          onChange={(e) => onLeftBehindChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-stellar"
        />
        {position.note}
      </label>
    </div>
  );
}
