import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret, PlaygroundConfigError } from "@/lib/playground/crypto";
import { loadSession, saveSession } from "@/lib/playground/session-server";
import {
  getPlaygroundIssuerKeypair,
  getPlaygroundMmKeypair,
} from "@/lib/playground/accounts-server";
import { executeMessStep, type MessContext } from "@/lib/playground/mess-builders";
import { isMessStepId } from "@/lib/playground/mess-plan";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  let body: { stepId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { stepId } = body;
  if (typeof stepId !== "string" || !isMessStepId(stepId)) {
    return NextResponse.json({ error: "invalid_step" }, { status: 400 });
  }
  if (session.completedMessSteps.includes(stepId)) {
    return NextResponse.json({ error: "step_already_executed" }, { status: 409 });
  }

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) {
    return NextResponse.json(
      { error: "Playground is not configured on this server." },
      { status: 503 }
    );
  }

  try {
    const ctx: MessContext = {
      demo: Keypair.fromSecret(decryptSecret(session.encDemoSecret)),
      ephemeralIssuers: new Map(
        session.ephemeralIssuers.map((e) => [
          e.assetCode,
          Keypair.fromSecret(decryptSecret(e.encSecret)),
        ])
      ),
      persistentIssuer: issuer,
      mmPublic: mm.publicKey(),
      fundRareAssets: session.fundRareAssets ?? [],
      offerCount: session.offerCount ?? 3,
      dataEntryCount: session.dataEntryCount ?? 3,
    };

    const txHash = await executeMessStep(stepId, ctx);

    session.completedMessSteps.push(stepId);
    await saveSession(session); // also refreshes the TTL

    return NextResponse.json({ stepId, txHash });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      console.error("[playground] misconfiguration:", err.message);
      return NextResponse.json(
        { error: "Playground is not configured on this server." },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[playground] mess step ${stepId} failed for session ${id}:`, err);
    return NextResponse.json({ error: "tx_failed", detail: message }, { status: 502 });
  }
}
