import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import { TOKEN_ADMIN_SECRET_ENV, tokenAdminKeypair } from "./token-deploy";

// Server-only: persistent playground accounts. PLAYGROUND_MM_SECRET_TESTNET
// serves three roles - it funds each demo account, it is the DEX liquidity
// counterparty during the mess step, and it is the fixed demolish merge
// destination - so the playground never asks a visitor for a destination
// address. Env vars have no NEXT_PUBLIC_ prefix.

export function getPlaygroundIssuerKeypair(): Keypair | null {
  const secret = process.env.PLAYGROUND_ISSUER_SECRET_TESTNET;
  if (!secret) return null;
  return Keypair.fromSecret(secret);
}

export function getPlaygroundMmKeypair(): Keypair | null {
  const secret = process.env.PLAYGROUND_MM_SECRET_TESTNET;
  if (!secret) return null;
  return Keypair.fromSecret(secret);
}

/** The playground token's admin, the only key that mints it (lib/scenarios/pinned.ts
 *  `PLAYGROUND_TOKEN`); null when unset or when it is any other key. */
export function getPlaygroundTokenAdminKeypair(): Keypair | null {
  return tokenAdminKeypair(process.env[TOKEN_ADMIN_SECRET_ENV]);
}
