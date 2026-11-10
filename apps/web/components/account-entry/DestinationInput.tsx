"use client";

import { useState, type ClipboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import type { Network } from "@/config/networks";
import { containsSecretKey, isValidGAddress, SECRET_KEY_WARNING } from "@/lib/utils/validation";
import {
  activeRegistry,
  isCexAddress,
  isRegistryUsable,
  memoTypeInDispute,
} from "@/lib/exchange-registry";
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
  network: Network;
  destination: string;
  onDestinationChange: (value: string) => void;
  memo: string;
  onMemoChange: (value: string) => void;
  /** The memo type for a destination the bundled registry does not list; a bundled one uses its
   *  own. */
  memoType: ChosenMemoType;
  onMemoTypeChange: (type: ChosenMemoType) => void;
  /** Whether `memoType` was picked for this destination. An exchange only the served registry
   *  lists shows no type as picked until it is. */
  memoTypeChosen: boolean;
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
  network,
  destination,
  onDestinationChange,
  memo,
  onMemoChange,
  memoType: chosenMemoType,
  onMemoTypeChange,
  memoTypeChosen,
  source,
  acknowledged,
  onAcknowledgedChange,
}: DestinationInputProps) {
  const field = memoField(destination, network, memo, chosenMemoType, memoTypeChosen);
  const memoRequired = field.required;
  const memoType = field.type;
  const [memoTouched, setMemoTouched] = useState(false);
  const [idEditRefused, setIdEditRefused] = useState(false);
  // Only that a key was refused is kept, never the key.
  const [memoSecretRefused, setMemoSecretRefused] = useState(false);
  const memoError = memoSecretRefused
    ? SECRET_KEY_WARNING
    : idEditRefused
      ? "An id memo is digits only."
      : memoTouched
        ? field.error
        : null;

  // The whole-key check only: unlike an address, a memo may well start with S.
  function refuseMemoSecret(): void {
    setMemoSecretRefused(true);
    setIdEditRefused(false);
    onMemoChange("");
  }

  function handleMemoPaste(e: ClipboardEvent<HTMLInputElement>): void {
    if (containsSecretKey(e.clipboardData?.getData("text") ?? "")) {
      e.preventDefault();
      refuseMemoSecret();
    }
  }

  function handleMemoChange(next: string): void {
    if (containsSecretKey(next)) {
      refuseMemoSecret();
      return;
    }
    setMemoSecretRefused(false);
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
  const needsAcknowledgement = isValidGAddress(destination) && !isCexAddress(destination, network);

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
            {field.listing === "served"
              ? `Check the memo type on ${field.exchangeName}'s deposit page and choose it here. A memo of the wrong type can leave the funds uncredited.`
              : "Use the type the receiving wallet shows. A numeric id sent as text is not the same memo."}
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
                  data-jump={value === "text" ? "destination-memo-type" : undefined}
                  type="radio"
                  name="destination-memo-type"
                  value={value}
                  checked={field.typeChosen && chosenMemoType === value}
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
          {field.fact === "type-mismatch" && (
            <p role="alert" className="text-xs text-danger-fg">
              {field.exchangeName}&apos;s deposit rules list a{" "}
              {field.servedType === "id" ? "numeric" : "text"} memo, not the{" "}
              {field.type === "id" ? "numeric" : "text"} memo you chose. A memo of the wrong type
              can leave the funds uncredited, so this close cannot go ahead. Check the memo type on
              the exchange&apos;s deposit page. If you are sure of your choice, choose another
              destination.
            </p>
          )}
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
                  {field.listing === "served"
                    ? `${field.exchangeName} requires a memo for all deposits.`
                    : `${field.exchangeName} requires a ${memoType === "id" ? "numeric" : "text"} memo for all deposits.`}
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
            {isCexAddress(destination, network) && !isRegistryUsable() && (
              <p role="alert" className="text-xs text-danger-fg">
                These deposit rules expired on {activeRegistry().validUntil} and have not been
                re-checked. Closing into an exchange on unverified rules can send the funds
                somewhere nobody can credit them, so this is blocked until they are refreshed.
              </p>
            )}
            {isCexAddress(destination, network) &&
              isRegistryUsable() &&
              memoTypeInDispute(destination) && (
                <p role="alert" className="text-xs text-danger-fg">
                  We could not confirm which kind of memo {field.exchangeName} expects: our two
                  copies of its deposit rules disagree. A memo of the wrong kind can leave the funds
                  uncredited, so closing into this exchange is blocked for now. Try again later, or
                  choose another destination.
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
          onPaste={handleMemoPaste}
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
