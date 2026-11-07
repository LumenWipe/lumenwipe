"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { activeRegistry, isCexAddress, isRegistryUsable } from "@/lib/exchange-registry";
import {
  memoField,
  refusesIdMemoEdit,
  TEXT_MEMO_MAX_BYTES,
  type ChosenMemoType,
} from "@/lib/plan/memo-field";
import { AddressField } from "@/components/ui/address-field";
import { Field, Input } from "@/components/ui/field";
import { Callout } from "@/components/ui/callout";

interface DestinationInputProps {
  destination: string;
  onDestinationChange: (value: string) => void;
  memo: string;
  onMemoChange: (value: string) => void;
  /** The memo type for a destination the registry does not list; a listed one uses its own. */
  memoType: ChosenMemoType;
  onMemoTypeChange: (type: ChosenMemoType) => void;
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
 * Destination address + optional/required memo, on the plan from its first paint.
 * Surfaces the exchange memo requirement from the registry and the
 * source-equals-destination warning.
 */
export default function DestinationInput({
  destination,
  onDestinationChange,
  memo,
  onMemoChange,
  memoType: chosenMemoType,
  onMemoTypeChange,
  source,
  acknowledged,
  onAcknowledgedChange,
}: DestinationInputProps) {
  const field = memoField(destination, memo, chosenMemoType);
  const memoRequired = field.required;
  const memoType = field.type;
  const [memoTouched, setMemoTouched] = useState(false);
  const [idEditRefused, setIdEditRefused] = useState(false);
  const memoError = idEditRefused ? "An id memo is digits only." : memoTouched ? field.error : null;

  function handleMemoChange(next: string): void {
    if (memoType === "id" && refusesIdMemoEdit(next)) {
      setIdEditRefused(true);
      return;
    }
    setIdEditRefused(false);
    onMemoChange(next);
  }

  // The registry lists a curated set of exchange deposit addresses; it cannot tell a personal
  // wallet from an exchange address it simply has not been told about. Merging straight into an
  // exchange deposit address is unrecoverable - exchanges credit payments carrying a memo and
  // cannot credit an account merge - so an address we do not recognize is confirmed by the only
  // party who knows where it came from, rather than assumed safe.
  const needsAcknowledgement = isValidGAddress(destination) && !isCexAddress(destination);

  return (
    <div className="space-y-4">
      <AddressField
        label="Destination address"
        value={destination}
        onChange={onDestinationChange}
        placeholder="G... (where to send your XLM)"
        helper="All XLM from the merged account will be transferred here. This can be an exchange address."
        required
      />

      {!field.typeFixed && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-fg">Memo type</legend>
          <p className="text-xs text-fg-subtle">
            Use the type the receiving wallet shows. A numeric id sent as text is not the same memo.
          </p>
          <div className="flex gap-4">
            {(
              [
                ["text", "Text"],
                ["id", "ID (numbers only)"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 text-xs text-white/80"
              >
                <input
                  type="radio"
                  name="destination-memo-type"
                  value={value}
                  checked={chosenMemoType === value}
                  onChange={() => {
                    setIdEditRefused(false);
                    onMemoTypeChange(value);
                  }}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <Field
        label={
          <>
            Payment memo
            {!memoRequired && <span className="ml-1 font-normal text-fg-muted">(optional)</span>}
          </>
        }
        required={memoRequired}
        error={memoError}
        helper={
          <div className="space-y-1.5">
            {memoType === "text" && (
              <p className="text-xs text-fg-subtle">
                {field.bytes} / {TEXT_MEMO_MAX_BYTES} bytes
              </p>
            )}
            {memoRequired ? (
              <>
                <p className="text-xs text-warning">
                  {field.exchangeName} requires a {memoType === "id" ? "numeric" : "text"} memo for
                  all deposits.
                </p>
                {/* The age of the rule, next to the rule. A memo requirement is data about the
                    outside world that changes without telling us, and this is the last screen
                    before something irreversible - so the user can see how old the thing they are
                    relying on is, and whether it came from the API or from the bundled floor. */}
                <p className="text-label text-fg-subtle">
                  Deposit rules last verified {activeRegistry().lastVerified}
                  {activeRegistry().served ? "" : " (offline copy)"}.
                </p>
              </>
            ) : (
              <p className="text-xs text-fg-subtle">
                Required by most exchanges to credit your deposit. Leave empty if not needed.
              </p>
            )}
            {/* Outside the memo branch on purpose. Keyed on "is this a listed exchange", the same
                condition that disables the button - nesting it under requiresMemo meant a listed
                exchange with no memo requirement produced a disabled button and no message
                anywhere on the page. */}
            {isCexAddress(destination) && !isRegistryUsable() && (
              <p role="alert" className="text-xs text-danger-fg">
                These deposit rules expired on {activeRegistry().validUntil} and have not been
                re-checked. Closing into an exchange on unverified rules can send the funds
                somewhere nobody can credit them, so this is blocked until they are refreshed.
              </p>
            )}
          </div>
        }
      >
        <Input
          data-jump="destination-memo"
          type="text"
          inputMode={memoType === "id" ? "numeric" : undefined}
          value={memo}
          onChange={(e) => handleMemoChange(e.target.value)}
          onBlur={() => setMemoTouched(true)}
          placeholder={memoType === "id" ? "Enter numeric ID" : "Enter memo text (max 28 bytes)"}
          spellCheck={false}
          autoComplete="off"
        />
      </Field>

      {needsAcknowledgement && (
        <Callout
          tone="warning"
          icon={<AlertTriangle className="h-4 w-4" />}
          title={<>We don&apos;t recognize this address as an exchange deposit address.</>}
        >
          <div className="space-y-2">
            <p className="text-xs text-white/60">
              That doesn&apos;t mean it isn&apos;t one. Closing directly into an exchange or
              custodial account loses the funds: exchanges credit deposits from payments carrying a
              memo, and cannot credit a closed account. LumenWipe sends to the exchanges it
              recognizes through a shared relay account, but it cannot do that for an address it
              does not know. If this one belongs to an exchange, close to a personal wallet you
              control and send it from there, including the exchange&apos;s deposit memo.
            </p>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
              <input
                data-jump="destination-acknowledge"
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => onAcknowledgedChange(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
              />
              This is a wallet I control, not an exchange or custodial account.
            </label>
          </div>
        </Callout>
      )}

      {source && destination && source === destination && (
        <Callout tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
          Source and destination are the same address.
        </Callout>
      )}
    </div>
  );
}
