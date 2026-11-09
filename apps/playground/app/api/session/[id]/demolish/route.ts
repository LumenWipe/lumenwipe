import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { actionResponse, notConfiguredResponse } from "@/lib/route-helpers";
import { runDemolishStep } from "@/lib/session-actions";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";
import { expectationFromSession } from "@/lib/verify";

// Must cover a full multi-round close plus network latency; the mess route
// uses the same budget for the same reason (Vercel would otherwise kill the
// function mid-poll and return a 504 before a slow tx confirms).
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const mm = getPlaygroundMmKeypair();
  const issuer = getPlaygroundIssuerKeypair();
  const apiUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!mm || !issuer || !apiUrl || !apiKey) return notConfiguredResponse();

  const result = await runDemolishStep(sessionStore, id, {
    demolish: (session, onConfirmed) =>
      runDemolish({
        demoKeypair: Keypair.fromSecret(decryptSecret(session.encDemoSecret)),
        expected: expectationFromSession(session, mm.publicKey(), issuer.publicKey()),
        apiUrl,
        apiKey,
        onConfirmed,
      }),
  });
  return actionResponse(result);
}
