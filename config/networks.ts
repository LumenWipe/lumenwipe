export type Network = "mainnet" | "testnet";

export const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

export const RPC_URLS: Record<Network, string> = {
  mainnet: process.env.NEXT_PUBLIC_STELLAR_RPC_MAINNET || "https://mainnet.sorobanrpc.com",
  testnet: process.env.NEXT_PUBLIC_STELLAR_RPC_TESTNET || "https://soroban-testnet.stellar.org",
};

export const SE_API_BASE: Record<Network, string> = {
  mainnet:
    process.env.NEXT_PUBLIC_SE_API_BASE_MAINNET || "https://api.stellar.expert/explorer/public",
  testnet:
    process.env.NEXT_PUBLIC_SE_API_BASE_TESTNET || "https://api.stellar.expert/explorer/testnet",
};

export const SE_EXPLORER_BASE: Record<Network, string> = {
  mainnet: "https://stellar.expert/explorer/public",
  testnet: "https://stellar.expert/explorer/testnet",
};

export const SV_EXPLORER_BASE: Record<Network, string> = {
  mainnet: "https://stellarview.acachete.xyz/en/mainnet",
  testnet: "https://stellarview.acachete.xyz/en/testnet",
};

export const NETWORK_LABELS: Record<Network, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
};

export const VALID_NETWORKS: Network[] = ["mainnet", "testnet"];

export function isValidNetwork(value: string): value is Network {
  return VALID_NETWORKS.includes(value as Network);
}

/**
 * Shared mediator (intermediary) account used to forward funds to exchange
 * destinations that don't support ACCOUNT_MERGE. The operator funds this
 * account once (its ~1 XLM base reserve is paid once and reused for everyone),
 * so users recover essentially all of their XLM. Public key is safe to expose;
 * the matching secret lives server-side only (see lib/stellar/mediator-server).
 */
export const MEDIATOR_PUBLIC_KEYS: Record<Network, string> = {
  mainnet: process.env.NEXT_PUBLIC_MEDIATOR_PUBLIC_MAINNET || "",
  testnet: process.env.NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET || "",
};

export function getMediatorPublicKey(network: Network): string {
  return MEDIATOR_PUBLIC_KEYS[network];
}
