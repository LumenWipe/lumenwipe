import { AlertTriangle } from "lucide-react";
import { Callout } from "@/components/ui/callout";

interface IssuerSupplyAcknowledgementProps {
  /** The plan's own wording, with the asset and holder counts; absent once it was acknowledged. */
  message: string | null;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}

/**
 * Shown when the account being closed issued assets that are still held. The merge succeeds on
 * the ledger and leaves those holders unable to redeem, which no transaction here can undo, so
 * the user states that they understand it. The answer travels to the API
 * (issuerSupplyAcknowledgementToDecisions), which re-checks it before building anything.
 */
export default function IssuerSupplyAcknowledgement({
  message,
  acknowledged,
  onAcknowledgedChange,
}: IssuerSupplyAcknowledgementProps) {
  return (
    <Callout
      tone="warning"
      announce={false}
      icon={<AlertTriangle className="h-4 w-4" />}
      title="This account issued assets that other accounts still hold."
    >
      <div className="space-y-2">
        {message && <p className="text-xs text-white/60">{message}</p>}
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledgedChange(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
          />
          I understand that merging this account leaves the holders of its assets unable to redeem
          them.
        </label>
      </div>
    </Callout>
  );
}
