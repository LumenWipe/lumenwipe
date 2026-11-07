"use client";

import type { JSX } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { NETWORK_NAME, type Network } from "@/config/networks";
import type { WalletKitConnection } from "@/hooks/useWalletKitConnection";
import { Button } from "@/components/ui/button";
import { walletConnectConfigured } from "@/lib/wallet-kit/modules";

/** Shown under the connect button on a build without a WalletConnect project id (never production:
 *  its build requires one). */
export const NO_WALLET_CONNECT_NOTE =
  "Mobile wallets, LOBSTR included, need WalletConnect, which is not set up on this deployment. Browser wallets still work.";

interface Props {
  connection: WalletKitConnection;
  disabled?: boolean;
  /** Shown alongside the connected pill (not instead of it - the user should
   *  still see what's connected) when that wallet is valid but wrong for the
   *  current context (e.g. doesn't match the account being closed). Absent/
   *  undefined means no such context-specific check applies. */
  mismatchWarning?: string;
  /** The keys that can sign here, listed with a one-click way to choose another wallet when the
   *  connected one cannot sign. */
  signerKeys?: readonly string[];
  /** The page's network, on a screen that signs: a wallet that does not report its network must
   *  then be confirmed to be on it. */
  signingNetwork?: Network;
}

function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** The account's signer keys, and a one-click switch to another wallet. */
export function OtherWalletChoice({
  connection,
  signerKeys,
}: {
  connection: WalletKitConnection;
  signerKeys: readonly string[];
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      {signerKeys.length > 0 && (
        <div className="text-xs text-fg-muted">
          <p>These keys can sign for this account:</p>
          <ul aria-label="Keys that can sign" className="mt-1 space-y-0.5">
            {signerKeys.map((key) => (
              <li key={key} className="font-mono-address text-white/80">
                {shortKey(key)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={connection.connecting}
        onClick={async () => {
          await connection.disconnect();
          await connection.connect();
        }}
      >
        Disconnect and choose another wallet
      </Button>
    </div>
  );
}

export default function WalletConnectPanel({
  connection,
  disabled,
  mismatchWarning,
  signerKeys,
  signingNetwork,
}: Props): JSX.Element {
  const { address, status, connecting, error, network, connect, disconnect } = connection;

  if (address && status === "checking") {
    return (
      <p
        role="status"
        className="rounded-lg border border-white/10 px-3 py-2.5 text-sm text-fg-muted"
      >
        Checking your wallet ({shortKey(address)})…
      </p>
    );
  }

  if (address && status === "stale") {
    return (
      <div className="space-y-1.5">
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Your wallet session ({shortKey(address)}) could not be checked. Reconnect your wallet
          before signing.
        </p>
        <Button
          type="button"
          onClick={connect}
          disabled={disabled || connecting}
          loading={connecting}
          className="w-full"
        >
          {connecting ? "Connecting…" : "Reconnect wallet"}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-danger-fg">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (address) {
    const warning =
      mismatchWarning ??
      (network === "no"
        ? "Your wallet is on a different network than this page. Switch networks in your wallet, or disconnect and reconnect the right one."
        : null);
    const askNetwork = signingNetwork !== undefined && network === "unknown" && !mismatchWarning;

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 bg-success/10 border border-success/20 rounded-lg px-3 py-2.5">
          <span className="flex items-center gap-2 text-sm text-success">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Connected: {shortKey(address)}
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
        {mismatchWarning && signerKeys && (
          <OtherWalletChoice connection={connection} signerKeys={signerKeys} />
        )}
        {askNetwork && (
          <label className="flex items-start gap-3 cursor-pointer select-none text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={connection.networkConfirmed}
              onChange={(e) => connection.confirmNetwork(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Your wallet does not report which network it is on. I checked that it is set to{" "}
              {NETWORK_NAME[signingNetwork]}.
            </span>
          </label>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        onClick={connect}
        disabled={disabled || connecting}
        loading={connecting}
        className="w-full"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </Button>
      {!walletConnectConfigured() && (
        <p className="text-xs text-fg-subtle">{NO_WALLET_CONNECT_NOTE}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
