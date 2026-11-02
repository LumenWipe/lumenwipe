"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { cn } from "@/lib/utils/cn";
import AddressInput from "./AddressInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import { findUnresolved } from "@/lib/session/recovery";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

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
      // The account may be gone with its merge unconfirmed: the gate on /analyze settles that.
      if (!(await findUnresolved(network, source))) {
        initSession();
        setPhase("ANALYZING");
      }
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
          <span className="text-danger-fg ml-1">*</span>
        </label>

        <div className="flex gap-2 rounded-lg bg-white/[0.03] p-1">
          <button
            type="button"
            onClick={() => setMode("wallet")}
            className={cn(
              "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
              mode === "wallet" ? "bg-white/10 text-white" : "text-fg-muted hover:text-white/80"
            )}
          >
            Connect wallet
          </button>
          <button
            type="button"
            onClick={() => setMode("address")}
            className={cn(
              "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
              mode === "address" ? "bg-white/10 text-white" : "text-fg-muted hover:text-white/80"
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

        <p className="text-xs text-fg-muted">
          We&apos;ll analyze this account&apos;s state so you can review and decide what happens to
          each balance before choosing a destination.
        </p>
      </div>

      {error && (
        <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {error}
        </Callout>
      )}

      <Button
        onClick={handleAnalyze}
        disabled={!canProceed || analyzing}
        loading={analyzing}
        className="w-full"
        iconEnd={<ArrowRight className="h-4 w-4" />}
      >
        {analyzing ? "Analyzing account..." : "Analyze account"}
      </Button>
    </div>
  );
}
