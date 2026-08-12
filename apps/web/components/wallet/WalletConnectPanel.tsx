"use client";

import type { JSX } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import type { WalletKitConnection } from "@/hooks/useWalletKitConnection";

interface Props {
  connection: WalletKitConnection;
  disabled?: boolean;
  /** Shown alongside the connected pill (not instead of it - the user should
   *  still see what's connected) when that wallet is valid but wrong for the
   *  current context (e.g. doesn't match the account being closed). Absent/
   *  undefined means no such context-specific check applies. */
  mismatchWarning?: string;
}

export default function WalletConnectPanel({
  connection,
  disabled,
  mismatchWarning,
}: Props): JSX.Element {
  const { address, connecting, error, networkMismatch, connect, disconnect } = connection;

  if (address) {
    const warning =
      mismatchWarning ??
      (networkMismatch
        ? "Your wallet is on a different network than this page. Switch networks in your wallet, or disconnect and reconnect the right one."
        : null);

    return (
      <div className="space-y-1.5">
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
        {warning && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {warning}
          </p>
        )}
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
