import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";
import { handleDemolishRound } from "@/lib/route-handlers";
import { expectedFeeAccount } from "@/lib/verify-feebump";

// One close round: its transactions, their resends and a confirmation lookup, far less than this.
// Kept at the mess route's budget so a slow confirmation is not cut off, and below
// SESSION_LOCK_TTL_MS (lib/session-store.ts), so a request the platform kills frees the session.
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDemolishRound(id, {
    store: sessionStore,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    feeAccount: expectedFeeAccount,
    decrypt: decryptSecret,
    runDemolish,
  });
}
