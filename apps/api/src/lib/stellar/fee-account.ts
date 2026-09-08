import { Keypair } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";

// Server-only: reads the fee-bump sponsor's secret from the environment (architecture.md §8.1).
// This module must never be imported from client code. The env vars carry no NEXT_PUBLIC_
// prefix, so they are never bundled into the browser - and unlike the mediator, the browser
// never needs to recognize this account at all: it is only ever the fee source of an outer
// fee-bump envelope the API builds and signs entirely server-side, never a party the client's
// own transaction names.

const SECRET_ENV: Record<Network, string> = {
  mainnet: "FEE_ACCOUNT_SECRET_MAINNET",
  testnet: "FEE_ACCOUNT_SECRET_TESTNET",
};

/**
 * Returns the fee-bump sponsor's keypair for the network, or null if no secret is configured (in
 * which case sponsored-fee closes are unavailable and the caller must say so, not guess).
 */
export function getFeeAccountKeypair(network: Network): Keypair | null {
  const secret = process.env[SECRET_ENV[network]];
  if (!secret) return null;
  return Keypair.fromSecret(secret);
}
