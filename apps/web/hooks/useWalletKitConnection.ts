"use client";

import { useCallback, useEffect, useState } from "react";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

export interface WalletKitConnection {
  address: string | null;
  connecting: boolean;
  error: string | null;
  /** True once a wallet is connected but its active network doesn't match this
   *  page's network — connected, but not usable until resolved. */
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

/**
 * Owns the wallet-kit connection lifecycle for any screen that needs it: connect,
 * disconnect, detecting a session already established elsewhere in the flow (the
 * kit is a static singleton that persists `activeAddress`/`selectedModuleId` to
 * localStorage, so a wallet connected during account entry is still connected by
 * the time the user reaches the sign step — this hook is what notices that,
 * instead of requiring a fresh click), and flagging a wallet/app network mismatch.
 */
export function useWalletKitConnection(network: Network): WalletKitConnection {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);

  const checkNetwork = useCallback(async () => {
    try {
      const kit = ensureWalletKitInitialized(network);
      const { networkPassphrase } = await kit.getNetwork();
      setNetworkMismatch(networkPassphrase !== NETWORK_PASSPHRASES[network]);
    } catch {
      // Some wallets don't implement getNetwork (e.g. LOBSTR via its own module,
      // per the kit's own source) — treat as unknown, not a mismatch.
      setNetworkMismatch(false);
    }
  }, [network]);

  // Detect a session already connected earlier in the flow, instead of requiring
  // a fresh click every time this hook mounts on a new page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kit = ensureWalletKitInitialized(network);
        const { address: existing } = await kit.getAddress();
        if (cancelled) return;
        setAddress(existing);
        await checkNetwork();
      } catch {
        // No existing session — nothing to restore.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, checkNetwork]);

  useEffect(() => {
    try {
      const kit = ensureWalletKitInitialized(network);
      return kit.on(KitEventType.DISCONNECT, () => {
        setAddress(null);
        setNetworkMismatch(false);
      });
    } catch {
      return undefined;
    }
  }, [network]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const kit = ensureWalletKitInitialized(network);
      const { address: connected } = await kit.authModal();
      setAddress(connected);
      await checkNetwork();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the wallet.");
    } finally {
      setConnecting(false);
    }
  }, [network, checkNetwork]);

  const disconnect = useCallback(async () => {
    await ensureWalletKitInitialized(network).disconnect();
    setAddress(null);
    setNetworkMismatch(false);
  }, [network]);

  return { address, connecting, error, networkMismatch, connect, disconnect };
}
