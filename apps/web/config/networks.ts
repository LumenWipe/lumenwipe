export type Network = "mainnet" | "testnet";

export const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

export const SE_EXPLORER_BASE: Record<Network, string> = {
  mainnet: "https://stellar.expert/explorer/public",
  testnet: "https://stellar.expert/explorer/testnet",
};

/** Where a transaction can be checked on the network's explorer, independently of LumenWipe. */
export function explorerTxUrl(network: Network, hash: string): string {
  return `${SE_EXPLORER_BASE[network]}/tx/${encodeURIComponent(hash)}`;
}

/** Where an account can be checked on the network's explorer. */
export function explorerAccountUrl(network: Network, address: string): string {
  return `${SE_EXPLORER_BASE[network]}/account/${encodeURIComponent(address)}`;
}

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
