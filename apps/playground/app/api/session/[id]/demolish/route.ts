import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret, PlaygroundConfigError } from "@/lib/crypto";
import { loadSession, saveSession } from "@/lib/session-store";
import { getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";

// Must cover a full multi-round close plus network latency; the mess route
// uses the same budget for the same reason (Vercel would otherwise kill the
// function mid-poll and return a 504 before a slow tx confirms).
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }
  if (session.demolishDone) {
    return NextResponse.json({ done: true });
  }

  const mm = getPlaygroundMmKeypair();
  const apiUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!mm || !apiUrl || !apiKey) {
    return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
  }

  try {
    const demoKeypair = Keypair.fromSecret(decryptSecret(session.encDemoSecret));

    await runDemolish({
      demoKeypair,
      sinkPublic: mm.publicKey(),
      apiUrl,
      apiKey,
      onConfirmed: (txId, hash) => {
        // Fire-and-forget append; a lost update here only means the frontend's
        // progress log is momentarily behind, not that the close itself failed.
        session.demolishLog.push({ txId, hash });
        void saveSession(session);
      },
    });

    session.demolishDone = true;
    await saveSession(session);
    return NextResponse.json({ done: true });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[playground] demolish failed for session ${id}:`, err);
    return NextResponse.json({ error: "demolish_failed", detail: message }, { status: 502 });
  }
}
