import { Keypair } from "@stellar/stellar-sdk";

// Server-only: persistent playground accounts. PLAYGROUND_MM_SECRET_TESTNET
// serves two roles - DEX liquidity counterparty during the mess step, and the
// fixed demolish merge destination - so the playground never asks a visitor
// for a destination address. Env vars have no NEXT_PUBLIC_ prefix.

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
