"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { toUserMessage } from "@/lib/utils/user-error";
import { startSignTimeout } from "@/lib/stellar/wallet-timeout";
import { WalletNotUsableError } from "@/lib/stellar/signer";
import {
  ADDRESS_CHECK_TIMEOUT_MS,
  ensureWalletKitInitialized,
  selectedWalletId,
  silentWalletAddress,
} from "@/lib/wallet-kit/client";

/** Whether the wallet is on this page's network: "unknown" when it cannot or did not say. */
export type WalletNetworkCheck = "yes" | "no" | "unknown";

/**
 * What the app has checked about the wallet session. "connected" only after the wallet itself
 * answered with this address in this page: a connect, or a silent lookup that matched. A restored
 * session is "checking" until then, and "stale" when the lookup failed, answered another account,
 * or the wallet cannot be asked without opening a prompt.
 */
export type WalletSessionStatus = "disconnected" | "checking" | "connected" | "stale";

/** The shortest gap between two re-checks started by the tab regaining focus. */
export const RECHECK_INTERVAL_MS = 5_000;

export interface WalletKitConnection {
  /** The account the session holds: checked only when `status` is "connected". */
  address: string | null;
  status: WalletSessionStatus;
  /** A check of the session is running; signing waits for it. */
  checking: boolean;
  connecting: boolean;
  error: string | null;
  network: WalletNetworkCheck;
  /** The user confirmed this wallet session is on this page's network. Only asked for, and only
   *  counted, while `network` is "unknown"; cleared on any address or network change. */
  networkConfirmed: boolean;
  confirmNetwork: (confirmed: boolean) => void;
  /** Connected and checked, on this page's network or confirmed to be. */
  verified: boolean;
  /** A check to run right before each signature with `address`: it waits for a check in flight
   *  and throws `WalletNotUsableError` when the session is no longer usable. */
  beforeSigning: (address: string) => () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface WalletKitConnectionOptions {
  /** Checks the session again when the tab regains focus, never opening a wallet prompt. */
  recheckOnFocus?: boolean;
}

/**
 * Owns the wallet-kit connection lifecycle for any screen that needs it, and claims only what it
 * has checked. The kit persists the last address to localStorage, so a session from earlier in
 * the flow is restored here, but shown as connected only once the wallet answers with that same
 * address; the wallet's network is read as yes, no or unknown, and a kit state change (a new
 * address) replaces the session. None of this opens a wallet prompt: a wallet that cannot be read
 * silently is asked to reconnect instead.
 */
export function useWalletKitConnection(
  network: Network,
  { recheckOnFocus = false }: WalletKitConnectionOptions = {}
): WalletKitConnection {
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatusState] = useState<WalletSessionStatus>("disconnected");
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletNetwork, setWalletNetworkState] = useState<WalletNetworkCheck>("unknown");
  const [walletId, setWalletIdState] = useState<string | null>(null);
  const [confirmedFor, setConfirmedForState] = useState<string | null>(null);

  // The same session state, kept current for a run that is already signing: `beforeSigning` reads
  // it at the moment of each signature, never the render a run started from.
  const liveRef = useRef<{
    status: WalletSessionStatus;
    network: WalletNetworkCheck;
    walletId: string | null;
    confirmedFor: string | null;
  }>({ status: "disconnected", network: "unknown", walletId: null, confirmedFor: null });
  const setStatus = useCallback((next: WalletSessionStatus) => {
    liveRef.current.status = next;
    setStatusState(next);
  }, []);
  const setWalletNetwork = useCallback((next: WalletNetworkCheck) => {
    liveRef.current.network = next;
    setWalletNetworkState(next);
  }, []);
  const setWalletId = useCallback((next: string | null) => {
    liveRef.current.walletId = next;
    setWalletIdState(next);
  }, []);
  const setConfirmedFor = useCallback((next: string | null) => {
    liveRef.current.confirmedFor = next;
    setConfirmedForState(next);
  }, []);

  // Read by callbacks that outlive a render: the address being checked, the one check allowed in
  // flight, when the last one started, and a generation that drops the answer of a check made for
  // a session that has since been replaced.
  const addressRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastCheckRef = useRef(0);
  const generationRef = useRef(0);

  const sessionKey = address ? `${network}|${walletId ?? ""}|${address}|${walletNetwork}` : null;
  const networkConfirmed = confirmedFor !== null && confirmedFor === sessionKey;
  // A confirmation belongs to one wallet session on one network: any change clears it, so coming
  // back to an earlier session asks again.
  useEffect(() => {
    setConfirmedFor(null);
  }, [sessionKey, setConfirmedFor]);

  const readNetwork = useCallback(async (): Promise<WalletNetworkCheck> => {
    const timer = startSignTimeout(ADDRESS_CHECK_TIMEOUT_MS);
    try {
      const answer = ensureWalletKitInitialized(network)
        .getNetwork()
        .then(
          ({ networkPassphrase }): WalletNetworkCheck =>
            !networkPassphrase
              ? "unknown"
              : networkPassphrase === NETWORK_PASSPHRASES[network]
                ? "yes"
                : "no",
          // Some wallets don't implement getNetwork (Albedo, Hana, WalletConnect, xBull, Rabet):
          // unknown, never a match.
          (): WalletNetworkCheck => "unknown"
        );
      return await Promise.race([answer, timer.expired.then((): WalletNetworkCheck => "unknown")]);
    } catch {
      return "unknown";
    } finally {
      timer.cancel();
    }
  }, [network]);

  /** Starts a session for `next`, dropping any check in flight: its answer is about another one. */
  const newSession = useCallback(
    (next: string | null) => {
      generationRef.current++;
      inFlightRef.current = null;
      addressRef.current = next;
      // A new session, even of the same wallet and address, is asked again: its network may have
      // been switched in between.
      setConfirmedFor(null);
      setChecking(false);
      setAddress(next);
      setWalletNetwork("unknown");
    },
    [setConfirmedFor, setWalletNetwork]
  );

  /** Reads the wallet's network for the current session as the one check in flight. */
  const trackNetworkRead = useCallback((): Promise<void> => {
    const generation = generationRef.current;
    lastCheckRef.current = Date.now();
    setChecking(true);
    const work: Promise<void> = readNetwork()
      .then((net) => {
        if (generation === generationRef.current) setWalletNetwork(net);
      })
      .finally(() => {
        if (inFlightRef.current !== work) return;
        inFlightRef.current = null;
        setChecking(false);
      });
    inFlightRef.current = work;
    return work;
  }, [readNetwork, setWalletNetwork]);

  // Asks the wallet, silently, which account and network it is on, and keeps "connected" only for
  // the address being checked. One check at a time: a second request joins the first.
  const verify = useCallback(
    (reason: "restore" | "focus"): Promise<void> => {
      if (inFlightRef.current) return inFlightRef.current;
      const expected = addressRef.current;
      if (!expected) return Promise.resolve();
      const generation = generationRef.current;
      lastCheckRef.current = Date.now();
      setChecking(true);
      const work = (async () => {
        const [live, net] = await Promise.all([
          silentWalletAddress(ensureWalletKitInitialized(network)),
          readNetwork(),
        ]);
        if (generation !== generationRef.current) return;
        setWalletNetwork(net);
        if (live === "unsupported") {
          // A restored session of a wallet that cannot be asked silently was never checked. One
          // connected in this page was, by the wallet's own answer, and stays as it is.
          if (reason === "restore") setStatus("stale");
        } else {
          setStatus(live === expected ? "connected" : "stale");
        }
      })().finally(() => {
        if (inFlightRef.current !== work) return;
        inFlightRef.current = null;
        setChecking(false);
      });
      inFlightRef.current = work;
      return work;
    },
    [network, readNetwork, setStatus, setWalletNetwork]
  );

  // Restores a session kept from earlier in the flow, shown as connected only once checked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let kit: ReturnType<typeof ensureWalletKitInitialized>;
      let existing: string;
      try {
        kit = ensureWalletKitInitialized(network);
        ({ address: existing } = await kit.getAddress());
      } catch {
        return; // No existing session - nothing to restore.
      }
      if (cancelled || addressRef.current !== null) return;
      newSession(existing);
      setWalletId(selectedWalletId(kit));
      setStatus("checking");
      await verify("restore");
    })();
    return () => {
      cancelled = true;
    };
  }, [network, newSession, verify, setStatus, setWalletId]);

  // A kit state change to another address replaces the session. The kit only takes a new address
  // from the wallet's own answer, so it counts as checked, and everything decided for the earlier
  // address (its network, its confirmation, the signer built on it) goes with it. The kit reports
  // the saved address once on subscribing; that report is not an answer from the wallet.
  useEffect(() => {
    let kit: ReturnType<typeof ensureWalletKitInitialized>;
    try {
      kit = ensureWalletKitInitialized(network);
    } catch {
      return undefined;
    }
    let subscribing = true;
    const offState = kit.on(KitEventType.STATE_UPDATED, (event) => {
      if (subscribing) return;
      const next = event.payload.address ?? null;
      if (next === addressRef.current) return;
      newSession(next);
      if (!next) {
        setStatus("disconnected");
        return;
      }
      setWalletId(selectedWalletId(kit));
      setStatus("connected");
      void trackNetworkRead();
    });
    subscribing = false;
    const offDisconnect = kit.on(KitEventType.DISCONNECT, () => {
      newSession(null);
      setStatus("disconnected");
    });
    return () => {
      offState();
      offDisconnect();
    };
  }, [network, newSession, trackNetworkRead, setStatus, setWalletId]);

  // Checks again when the tab comes back: at most one lookup in flight and one per interval.
  useEffect(() => {
    if (!recheckOnFocus) return undefined;
    const recheck = (): void => {
      if (document.visibilityState === "hidden" || !addressRef.current) return;
      // A lookup still in flight is joined by verify(), never started twice.
      if (Date.now() - lastCheckRef.current < RECHECK_INTERVAL_MS) return;
      void verify("focus");
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [recheckOnFocus, verify]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const kit = ensureWalletKitInitialized(network);
      const { address: connected } = await kit.authModal();
      newSession(connected);
      setWalletId(selectedWalletId(kit));
      setStatus("connected");
      await trackNetworkRead();
    } catch (err) {
      setError(toUserMessage(err, "wallet"));
    } finally {
      setConnecting(false);
    }
  }, [network, newSession, trackNetworkRead, setStatus, setWalletId]);

  const disconnect = useCallback(async () => {
    setError(null);
    try {
      await ensureWalletKitInitialized(network).disconnect();
      newSession(null);
      setStatus("disconnected");
    } catch (err) {
      setError(toUserMessage(err, "wallet"));
    }
  }, [network, newSession, setStatus]);

  const confirmNetwork = useCallback(
    (confirmed: boolean) => setConfirmedFor(confirmed ? sessionKey : null),
    [sessionKey, setConfirmedFor]
  );

  // Checked again at each signature of a run, after any check still in flight settles: a session
  // that went stale, moved to another address or network, or lost its confirmation since the run
  // started stops the run before the wallet is asked.
  const beforeSigning = useCallback(
    (expected: string) => async (): Promise<void> => {
      if (inFlightRef.current) await inFlightRef.current;
      const now = liveRef.current;
      const current = addressRef.current;
      if (now.status !== "connected" || current !== expected) {
        throw new WalletNotUsableError("session", network);
      }
      if (now.network === "no") throw new WalletNotUsableError("network", network);
      const key = `${network}|${now.walletId ?? ""}|${current}|${now.network}`;
      if (now.network === "unknown" && now.confirmedFor !== key) {
        throw new WalletNotUsableError("network-unconfirmed", network);
      }
    },
    [network]
  );

  const verified =
    status === "connected" &&
    (walletNetwork === "yes" || (walletNetwork === "unknown" && networkConfirmed));

  return {
    address,
    status,
    checking,
    connecting,
    error,
    network: walletNetwork,
    networkConfirmed,
    confirmNetwork,
    verified,
    beforeSigning,
    connect,
    disconnect,
  };
}
