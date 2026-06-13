"use client";

import { AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { getMemoRequirement } from "@/lib/exchange-registry";
import AddressInput from "./AddressInput";

interface DestinationInputProps {
  destination: string;
  onDestinationChange: (value: string) => void;
  memo: string;
  onMemoChange: (value: string) => void;
  source: string;
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
}: DestinationInputProps) {
  const memoReq = isValidGAddress(destination) ? getMemoRequirement(destination) : null;
  const memoRequired = memoReq?.requiresMemo ?? false;
  const memoType = memoReq?.memoType ?? "text";

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
          <p className="text-xs text-amber-500">
            {memoReq.exchangeName} requires a {memoType === "id" ? "numeric" : "text"} memo for all
            deposits.
          </p>
        ) : (
          <p className="text-xs text-white/40">
            Required by most exchanges to credit your deposit. Leave empty if not needed.
          </p>
        )}
        <input
          type={memoType === "id" ? "number" : "text"}
          value={memo}
          onChange={(e) => onMemoChange(e.target.value)}
          placeholder={memoType === "id" ? "Enter numeric ID" : "Enter memo text (max 28 chars)"}
          maxLength={memoType === "text" ? 28 : undefined}
          className="w-full text-sm bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-stellar/40"
        />
      </div>

      {source && destination && source === destination && (
        <div className="flex items-start gap-2 text-sm text-warning bg-warning/10 border border-warning/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          Source and destination are the same address.
        </div>
      )}
    </div>
  );
}
