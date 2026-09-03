export type Network = "mainnet" | "testnet";

export const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

export const RPC_URLS: Record<Network, string> = {
  mainnet: process.env.NEXT_PUBLIC_STELLAR_RPC_MAINNET || "https://mainnet.sorobanrpc.com",
  testnet: process.env.NEXT_PUBLIC_STELLAR_RPC_TESTNET || "https://soroban-testnet.stellar.org",
};

export const PATH_ROUTING_API_URLS: Record<Network, string> = {
  mainnet: process.env.NEXT_PUBLIC_PATH_ROUTING_API_MAINNET || "",
  testnet: process.env.NEXT_PUBLIC_PATH_ROUTING_API_TESTNET || "",
};

/**
 * OctoPos, the DeFi position provider (architecture.md §7.1). Empty by default - unlike
 * RPC_URLS this is a specific commercial third party whose absence is a fully supported
 * product state (degraded mode: classic-only close, DeFi detection unavailable), not a missing
 * essential dependency, so it is never given a compiled-in public default.
 *
 * Deliberately not network-keyed like PATH_ROUTING_API_URLS or MEDIATOR_PUBLIC_KEYS: those have
 * a real provider on both networks, OctoPos does not. Its own OpenAPI spec declares a testnet
 * server entry, but that hostname does not resolve (confirmed against three DNS resolvers while
 * building #146) - it is undeployed, not merely unconfigured. Add a testnet constant back if
 * OctoPos ever actually ships one; a config slot for a host that does not exist is exactly the
 * kind of speculative surface CLAUDE.md's "don't design for hypothetical future requirements"
 * warns against.
 */
export const OCTOPOS_API_URL_MAINNET: string = process.env.OCTOPOS_API_URL_MAINNET || "";

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

function buildRpcHeaders(name?: string, value?: string): Record<string, string> {
  if (!name) return {};
  return { [name]: value ?? "" };
}

export const RPC_HEADERS: Record<Network, Record<string, string>> = {
  mainnet: buildRpcHeaders(
    process.env.NEXT_PUBLIC_STELLAR_RPC_HEADER_NAME_MAINNET,
    process.env.NEXT_PUBLIC_STELLAR_RPC_HEADER_VALUE_MAINNET
  ),
  testnet: buildRpcHeaders(
    process.env.NEXT_PUBLIC_STELLAR_RPC_HEADER_NAME_TESTNET,
    process.env.NEXT_PUBLIC_STELLAR_RPC_HEADER_VALUE_TESTNET
  ),
};

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
