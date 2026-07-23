"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import AddressInput from "./AddressInput";

export default function AccountEntryForm() {
  const router = useRouter();
  const network = useNetworkStore((s) => s.network);
  const { setPhase, initSession } = useDemolishStore();

  const [source, setSource] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canProceed = isValidGAddress(source);

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

      initSession();
      setPhase("ANALYZING");

      router.push(`/${network}/analyze?source=${source}`);
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
        helpText="Enter the account you want to close. We'll analyze its state so you can review and decide what happens to each balance before choosing a destination."
        required
      />

      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={!canProceed || analyzing}
        className="w-full flex items-center justify-center gap-2 bg-stellar text-black font-semibold py-3 px-4 rounded-xl hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
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
