"use client";

import { AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import {
  activeRegistry,
  getMemoRequirement,
  isCexAddress,
  isRegistryUsable,
} from "@/lib/exchange-registry";
import AddressInput from "./AddressInput";

interface DestinationInputProps {
  destination: string;
  onDestinationChange: (value: string) => void;
  memo: string;
  onMemoChange: (value: string) => void;
  source: string;
  /**
   * True when the user has confirmed they control an unrecognized destination. Both of these
   * are required, not optional: this component is the only place the risk is explained, and an
   * optional prop a future call site forgets would silently restore the fail-open default this
   * exists to close. Omitting them is a type error, not a silent downgrade.
   */
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}

/**
 * Destination address + optional/required memo, reused by the late-destination step.
 * Surfaces the exchange memo requirement from the registry and the
 * source-equals-destination warning.
 */
export default function DestinationInput({
  destination,
  onDestinationChange,
  memo,
  onMemoChange,
  source,
  acknowledged,
  onAcknowledgedChange,
}: DestinationInputProps) {
  const memoReq = isValidGAddress(destination) ? getMemoRequirement(destination) : null;
  const memoRequired = memoReq?.requiresMemo ?? false;
  const memoType = memoReq?.memoType ?? "text";

  // The registry lists a curated set of exchange deposit addresses; it cannot tell a personal
  // wallet from an exchange address it simply has not been told about. Merging straight into an
  // exchange deposit address is unrecoverable - exchanges credit payments carrying a memo and
  // cannot credit an account merge - so an address we do not recognize is confirmed by the only
  // party who knows where it came from, rather than assumed safe.
  const needsAcknowledgement = isValidGAddress(destination) && !isCexAddress(destination);

  return (
    <div className="space-y-4">
      <AddressInput
        label="Destination address"
        value={destination}
        onChange={onDestinationChange}
        placeholder="G... (where to send your XLM)"
        helpText="All XLM from the merged account will be transferred here. This can be an exchange address."
        required
      />

      <div className="space-y-1.5">
        <label className="text-sm font-medium flex items-center gap-1">
          Payment memo
          {memoRequired ? (
            <span className="text-destructive ml-0.5">*</span>
          ) : (
            <span className="text-muted-foreground font-normal">(optional)</span>
          )}
        </label>
        {memoReq?.requiresMemo ? (
          <>
            <p className="text-xs text-amber-500">
              {memoReq.exchangeName} requires a {memoType === "id" ? "numeric" : "text"} memo for
              all deposits.
            </p>
            {/* The age of the rule, next to the rule. A memo requirement is data about the
                outside world that changes without telling us, and this is the last screen
                before something irreversible - so the user can see how old the thing they are
                relying on is, and whether it came from the API or from the bundled floor. */}
            <p className="text-[0.7rem] text-white/40">
              Deposit rules last verified {activeRegistry().lastVerified}
              {activeRegistry().served ? "" : " (offline copy)"}.
            </p>
          </>
        ) : (
          <p className="text-xs text-white/40">
            Required by most exchanges to credit your deposit. Leave empty if not needed.
          </p>
        )}
        {/* Outside the memo branch on purpose. Keyed on "is this a listed exchange", the same
            condition that disables the button - nesting it under requiresMemo meant a listed
            exchange with no memo requirement produced a disabled button and no message
            anywhere on the page. */}
        {isCexAddress(destination) && !isRegistryUsable() && (
          <p role="alert" className="text-xs text-destructive">
            These deposit rules expired on {activeRegistry().validUntil} and have not been
            re-checked. Closing into an exchange on unverified rules can send the funds somewhere
            nobody can credit them, so this is blocked until they are refreshed.
          </p>
        )}
        <input
          type={memoType === "id" ? "number" : "text"}
          value={memo}
          onChange={(e) => onMemoChange(e.target.value)}
          placeholder={memoType === "id" ? "Enter numeric ID" : "Enter memo text (max 28 bytes)"}
          maxLength={memoType === "text" ? 28 : undefined}
          className="w-full text-sm bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-stellar/40"
        />
      </div>

      {needsAcknowledgement && (
        <div className="space-y-2 rounded-lg border border-warning/20 bg-warning/10 p-3">
          <div className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>We don&apos;t recognize this address as an exchange deposit address.</span>
          </div>
          <p className="text-xs text-white/60">
            That doesn&apos;t mean it isn&apos;t one. Closing directly into an exchange or custodial
            account loses the funds: exchanges credit deposits from payments carrying a memo, and
            cannot credit a closed account. LumenWipe sends to the exchanges it recognizes through a
            shared intermediary account, but it cannot do that for an address it does not know. If
            this one belongs to an exchange, close to a personal wallet you control and send it from
            there, including the exchange&apos;s deposit memo.
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledgedChange(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-stellar"
            />
            This is a wallet I control, not an exchange or custodial account.
          </label>
        </div>
      )}

      {source && destination && source === destination && (
        <div className="flex items-start gap-2 text-sm text-warning bg-warning/10 border border-warning/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          Source and destination are the same address.
        </div>
      )}
    </div>
  );
}
