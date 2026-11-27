import { AlertTriangle } from "lucide-react";
import { Callout } from "@/components/ui/callout";

interface DefiPositionsAcknowledgementProps {
  sweepCompleted: boolean;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}

/**
 * Shown only when the plan carries the API's `defi_positions_unavailable` blocker: OctoPos
 * could not confirm this account, and either the direct on-chain sweep did not complete or it
 * found nothing while the account holds trustlines its zero-trustline leniency does not cover
 * (they could in principle be anything). A human who checked manually - e.g. on an explorer -
 * can acknowledge that here; the answer travels to the API (defiPositionsAcknowledgementToDecisions)
 * exactly like the destination acknowledgement above it, and the API re-checks it before ever
 * building a transaction.
 */
export default function DefiPositionsAcknowledgement({
  sweepCompleted,
  acknowledged,
  onAcknowledgedChange,
}: DefiPositionsAcknowledgementProps) {
  return (
    <Callout
      tone="warning"
      announce={false}
      icon={<AlertTriangle className="h-4 w-4" />}
      title={
        sweepCompleted
          ? "Confirm what this account's trustlines are for."
          : "DeFi position data for this account could not be confirmed."
      }
    >
      <div className="space-y-2">
        <p className="text-xs text-white/60">
          {sweepCompleted ? (
            <>
              A direct on-chain check found no open DeFi positions in the protocols LumenWipe
              recognizes today, but it cannot rule out one it does not recognize. Check this
              account&apos;s trustlines yourself (e.g. on an explorer) before continuing.
            </>
          ) : (
            <>
              The on-chain check of this account&apos;s DeFi positions could not be completed, so it
              may hold open positions that were not detected. Check this account&apos;s trustlines
              yourself (e.g. on an explorer) before continuing.
            </>
          )}
        </p>
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledgedChange(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
          />
          I checked this account&apos;s trustlines myself and confirmed they are for other assets,
          not open DeFi positions.
        </label>
      </div>
    </Callout>
  );
}
