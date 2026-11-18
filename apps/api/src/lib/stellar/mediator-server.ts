import type { Keypair } from "@stellar/stellar-sdk";
import { Logger } from "@nestjs/common";
import type { Network } from "@/config/networks";
import type { MediatorKeyProvider } from "@/common/ports";
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

/** Whether the relay can co-sign on a network, and the key to sign with when it can. */
export type RelayKey =
  | { state: "usable"; keypair: Keypair }
  /** No valid seed, or `MEDIATOR_PUBLIC_<NETWORK>` is unset. */
  | { state: "not_configured" }
  /** A seed loads but its public key is not `MEDIATOR_PUBLIC_<NETWORK>`. */
  | { state: "mismatch" };

/**
 * The one decision on whether the relay is usable: a seed loads, the public key is set, and the
 * two are the same StrKey. Compared as exact strings, because the configured public key is the
 * string the close builder writes as the merge destination, so only an exact match is a
 * transaction this key can co-sign.
 */
export function relayKey(keys: MediatorKeyProvider, network: Network): RelayKey {
  const keypair = keys.keypair(network);
  const configuredPublic = keys.configuredPublicKey(network);
  if (!keypair || configuredPublic === "") return { state: "not_configured" };
  if (keypair.publicKey() !== configuredPublic) return { state: "mismatch" };
  return { state: "usable", keypair };
}
