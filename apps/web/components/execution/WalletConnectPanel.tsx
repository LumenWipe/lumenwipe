"use client";

import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle } from "lucide-react";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import type { Network } from "@/config/networks";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

interface Props {
  network: Network;
  onConnected: (publicKey: string) => void;
  onDisconnected: () => void;
  disabled?: boolean;
}

export default function WalletConnectPanel({ network, onConnected, onDisconnected, disabled }: Props): React.ReactElement {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const kit = ensureWalletKitInitialized(network);
    return kit.on(KitEventType.DISCONNECT, () => {
      setAddress(null);
      onDisconnected();
    });
  }, [network, onDisconnected]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const kit = ensureWalletKitInitialized(network);
      const { address: connected } = await kit.authModal();
      setAddress(connected);
      onConnected(connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the wallet.");
    } finally {
      setConnecting(false);
    }
  }, [network, onConnected]);

  const disconnect = useCallback(async () => {
    await ensureWalletKitInitialized(network).disconnect();
    setAddress(null);
    onDisconnected();
  }, [network, onDisconnected]);

  if (address) {
    return (
      <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Connected: {address.slice(0, 4)}…{address.slice(-4)}
        </span>
        <button
          type="button"
          onClick={disconnect}
          className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={connect}
        disabled={disabled || connecting}
        className="w-full py-2.5 px-4 rounded-lg font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
