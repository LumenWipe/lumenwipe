import type { Keypair } from "@stellar/stellar-sdk";
import { Logger } from "@nestjs/common";
import type { Network } from "@/config/networks";
import { keypairFromEnv } from "@/lib/stellar/secret-keypair";

const logger = new Logger("mediator-server");

// Server-only: reads the shared mediator secret from the environment. This
// module must never be imported from client code. The env vars have no
// NEXT_PUBLIC_ prefix, so they are never bundled into the browser.

const SECRET_ENV: Record<Network, string> = {
  mainnet: "MEDIATOR_SECRET_MAINNET",
  testnet: "MEDIATOR_SECRET_TESTNET",
};

/**
 * Returns the shared mediator keypair for the network, or null if no secret is
 * configured or the configured value is not a valid secret seed (in which case the
 * exchange-merge flow is unavailable and answers `mediator_not_configured`).
 */
export function getMediatorKeypair(network: Network): Keypair | null {
  return keypairFromEnv(SECRET_ENV[network], logger);
}
