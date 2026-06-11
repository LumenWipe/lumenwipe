import { Keypair } from "@stellar/stellar-sdk";

// Server-only: persistent playground accounts (LWDEMO issuer + market maker).
// Env vars have no NEXT_PUBLIC_ prefix, so they are never bundled client-side.
// Public keys are derived from the secrets and handed to the client via API.

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
