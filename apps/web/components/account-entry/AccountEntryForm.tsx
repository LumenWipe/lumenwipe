"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { AddressField } from "@/components/ui/address-field";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import { findUnresolved } from "@/lib/session/recovery";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Tabs, type TabItem } from "@/components/ui/tabs";

type EntryMode = "wallet" | "address";

const ENTRY_MODES: readonly TabItem<EntryMode>[] = [
  { value: "wallet", label: "Connect wallet" },
  { value: "address", label: "Paste address" },
];

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
        <p className="text-sm font-medium text-white">
          Account to close
          <span aria-hidden="true" className="text-danger-fg ml-1">
            *
          </span>
        </p>

        <Tabs
          label="How to choose the account"
          items={ENTRY_MODES}
          value={mode}
          onValueChange={setMode}
        >
          {mode === "wallet" ? (
            <WalletConnectPanel connection={walletConnection} disabled={analyzing} />
          ) : (
            <AddressField
              label="Account to close"
              hideLabel
              required
              value={pastedSource}
              onChange={setPastedSource}
              placeholder="G... (the account to merge)"
            />
          )}
        </Tabs>

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
