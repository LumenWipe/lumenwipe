"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { cn } from "@/lib/utils/cn";
import AddressInput from "./AddressInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";

type EntryMode = "wallet" | "address";

export default function AccountEntryForm() {
  const router = useRouter();
  const network = useNetworkStore((s) => s.network);
  const { setPhase, initSession } = useDemolishStore();
  const walletConnection = useWalletKitConnection(network);

  const [mode, setMode] = useState<EntryMode>("wallet");
  const [pastedSource, setPastedSource] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = mode === "wallet" ? (walletConnection.address ?? "") : pastedSource;
  const canProceed =
    isValidGAddress(source) && !(mode === "wallet" && walletConnection.networkMismatch);

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
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-white">
          Account to close
          <span className="text-destructive ml-1">*</span>
        </label>

        <div className="flex gap-2 rounded-lg bg-white/[0.03] p-1">
          <button
            type="button"
            onClick={() => setMode("wallet")}
            className={cn(
              "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
              mode === "wallet" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
            )}
          >
            Connect wallet
          </button>
          <button
            type="button"
            onClick={() => setMode("address")}
            className={cn(
              "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
              mode === "address" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
            )}
          >
            Paste address
          </button>
        </div>

        {mode === "wallet" ? (
          <WalletConnectPanel connection={walletConnection} disabled={analyzing} />
        ) : (
          <AddressInput
            label=""
            value={pastedSource}
            onChange={setPastedSource}
            placeholder="G... (the account to merge)"
          />
        )}

        <p className="text-xs text-muted-foreground">
          We&apos;ll analyze this account&apos;s state so you can review and decide what happens to
          each balance before choosing a destination.
        </p>
      </div>

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
