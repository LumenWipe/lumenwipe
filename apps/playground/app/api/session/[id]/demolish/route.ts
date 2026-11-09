import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";
import { handleDemolish } from "@/lib/route-handlers";

// Must cover a full multi-round close plus network latency; the mess route
// uses the same budget for the same reason (Vercel would otherwise kill the
// function mid-poll and return a 504 before a slow tx confirms).
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDemolish(id, {
    store: sessionStore,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    decrypt: decryptSecret,
    runDemolish,
  });
}
