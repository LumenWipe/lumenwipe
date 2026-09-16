import { AlertTriangle } from "lucide-react";

interface DefiPositionsAcknowledgementProps {
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}

/**
 * Shown only when the plan carries the API's `defi_positions_unavailable` blocker: OctoPos
 * could not confirm this account and a direct on-chain sweep found nothing, but the account
 * holds trustlines the sweep's own zero-trustline leniency does not cover (they could in
 * principle be anything). A human who checked manually - e.g. on an explorer - can acknowledge
 * that here; the answer travels to the API (defiPositionsAcknowledgementToDecisions) exactly
 * like the destination acknowledgement above it, and the API re-checks it before ever building
 * a transaction.
 */
export default function DefiPositionsAcknowledgement({
  acknowledged,
  onAcknowledgedChange,
}: DefiPositionsAcknowledgementProps) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/20 bg-warning/10 p-3">
      <div className="flex items-start gap-2 text-sm text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>DeFi position data for this account could not be confirmed.</span>
      </div>
      <p className="text-xs text-white/60">
        A direct on-chain check found no open DeFi positions, but this check only covers protocols
        LumenWipe recognizes today - it cannot rule out every possibility. Check this account&apos;s
        trustlines yourself (e.g. on an explorer) before continuing.
      </p>
      <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledgedChange(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-stellar"
        />
        I checked this account&apos;s trustlines myself and confirmed they are for other assets, not
        open DeFi positions.
      </label>
    </div>
  );
}
