import { Keypair } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";

// Server-only: reads the shared mediator secret from the environment. This
// module must never be imported from client code. The env vars have no
// NEXT_PUBLIC_ prefix, so they are never bundled into the browser.

const SECRET_ENV: Record<Network, string> = {
  mainnet: "MEDIATOR_SECRET_MAINNET",
  testnet: "MEDIATOR_SECRET_TESTNET",
};

/**
 * Returns the shared mediator keypair for the network, or null if no secret is
 * configured (in which case the exchange-merge flow is unavailable).
 */
export function getMediatorKeypair(network: Network): Keypair | null {
  const secret = process.env[SECRET_ENV[network]];
  if (!secret) return null;
  return Keypair.fromSecret(secret);
}
