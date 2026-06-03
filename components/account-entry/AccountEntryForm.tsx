"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import { isValidGAddress, isValidMemo } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { getMemoRequirement } from "@/lib/exchange-registry";
import AddressInput from "./AddressInput";

export default function AccountEntryForm() {
  const router = useRouter();
  const network = useNetworkStore((s) => s.network);
  const { setAddresses, setPhase, initSession } = useDemolishStore();

  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [memo, setMemo] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memoReq = isValidGAddress(destination) ? getMemoRequirement(destination) : null;
  const memoRequired = memoReq?.requiresMemo ?? false;
  const memoType = memoReq?.memoType ?? "text";
  const memoValid = !memoRequired || (memo.trim().length > 0 && isValidMemo(memo.trim(), memoType));

  const canProceed = isValidGAddress(source) && isValidGAddress(destination) && memoValid;

  async function handleAnalyze() {
    if (!canProceed) return;
    setAnalyzing(true);
    setError(null);

    try {
      // Validate that source account exists before navigating
      const res = await fetch(`/api/${network}/account/${source}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Account not found on this network.");
        return;
      }

      // Store addresses and secret key reference in app state
      const effectiveMemoType = memoRequired ? memoType : undefined;
      setAddresses(source, destination, memo.trim() || undefined, effectiveMemoType);
      initSession();
      setPhase("ANALYZING");

      router.push(`/${network}/analyze?source=${source}&dest=${destination}`);
    } catch {
      setError("Failed to connect to the Stellar network. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="space-y-6">
      <AddressInput
        label="Account to close"
        value={source}
        onChange={setSource}
        placeholder="G... (the account to merge)"
        helpText="The source account to merge. All subentry reserves (trustlines, offers, data entries) will be recovered to the destination."
        required
      />

      <AddressInput
        label="Destination address"
        value={destination}
        onChange={setDestination}
        placeholder="G... (where to send your XLM)"
        helpText="All XLM from the merged account will be transferred here. This can be an exchange address."
        required
      />

      {isValidGAddress(destination) && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium flex items-center gap-1">
            Payment memo
            {memoRequired ? (
              <span className="text-destructive ml-0.5">*</span>
            ) : (
              <span className="text-muted-foreground font-normal">(optional)</span>
            )}
          </label>
          {memoReq?.requiresMemo && (
            <p className="text-xs text-amber-500">
              {memoReq.exchangeName} requires a {memoType === "id" ? "numeric" : "text"} memo for
              all deposits.
            </p>
          )}
          <input
            type={memoType === "id" ? "number" : "text"}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={memoType === "id" ? "Enter numeric ID" : "Enter memo text (max 28 chars)"}
            maxLength={memoType === "text" ? 28 : undefined}
            className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-stellar/40"
          />
        </div>
      )}

      {source && destination && source === destination && (
        <div className="flex items-start gap-2 text-sm text-warning bg-warning/10 border border-warning/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          Source and destination are the same address.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={!canProceed || analyzing || source === destination}
        className="w-full flex items-center justify-center gap-2 bg-stellar text-black font-semibold py-2.5 px-4 rounded-lg hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {analyzing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing account...
          </>
        ) : (
          <>
            Analyze account
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </div>
  );
}
