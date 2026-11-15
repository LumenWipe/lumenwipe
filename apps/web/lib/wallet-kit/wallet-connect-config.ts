// No wallet-kit code here: the entry page reads this before any wallet is chosen.

export interface WalletConnectMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

/**
 * Must match the domain the page actually loads from - WalletConnect compares `url` against
 * the real page origin and flags a mismatch to the connecting wallet as a possible phishing
 * signal. The site serves from the www subdomain, so the fallback (used whenever
 * `NEXT_PUBLIC_APP_URL` is unset) has to be that, not the bare apex domain.
 */
export function walletConnectMetadata(): WalletConnectMetadata {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.lumenwipe.com";
  return {
    name: "LumenWipe",
    description: "Close your Stellar account safely and recover your XLM.",
    url: appUrl,
    icons: [`${appUrl}/favicon-96x96.png`],
  };
}

/**
 * Whether this build has a WalletConnect project id. Without one, mobile wallets (LOBSTR
 * included) are unavailable and the wallet picker says so. A production deployment cannot be
 * built without it (`config/wallet-connect-build.mjs`).
 */
export function walletConnectConfigured(): boolean {
  return walletConnectProjectId() !== null;
}

export function walletConnectProjectId(): string | null {
  return process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID?.trim() || null;
}
