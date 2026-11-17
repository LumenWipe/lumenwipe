import type { WalletKitConnection } from "@/hooks/useWalletKitConnection";

/** A connection with no wallet connected unless a test sets one. */
export function walletConnection(
  overrides: Partial<WalletKitConnection> = {}
): WalletKitConnection {
  return {
    address: null,
    status: "disconnected",
    checking: false,
    connecting: false,
    error: null,
    network: "unknown",
    networkConfirmed: false,
    confirmNetwork: () => {},
    verified: false,
    beforeSigning: () => async () => {},
    connect: async () => {},
    disconnect: async () => {},
    ...overrides,
  };
}
