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
