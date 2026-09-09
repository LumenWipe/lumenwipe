import { Keypair } from "@stellar/stellar-sdk";
import { Logger } from "@nestjs/common";
import type { Network } from "@/config/networks";

const logger = new Logger("fee-account");

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
 * which case sponsored-fee closes are unavailable and the caller must say so, not guess) or the
 * configured value is not a valid secret seed - a misconfiguration, not a client-triggerable
 * error, but one the controller must still turn into the same clean 503 rather than a raw,
 * unhandled 500 (CLAUDE.md's "never surface raw SDK codes or stack traces").
 */
export function getFeeAccountKeypair(network: Network): Keypair | null {
  const secret = process.env[SECRET_ENV[network]];
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    logger.error(`${SECRET_ENV[network]} is set but is not a valid Stellar secret seed`);
    return null;
  }
}
