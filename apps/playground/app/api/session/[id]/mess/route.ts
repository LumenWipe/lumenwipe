import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret, PlaygroundConfigError } from "@/lib/crypto";
import { saveSession } from "@/lib/session-store";
import { loadSessionOrErrorResponse } from "@/lib/route-helpers";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import { isMessStepId } from "@/lib/mess-plan";

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionOrErrorResponse(id);
  if (session instanceof NextResponse) return session;

  let stepId: unknown;
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") {
      throw new Error("invalid body");
    }
    stepId = (body as Record<string, unknown>).stepId;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof stepId !== "string" || !isMessStepId(stepId)) {
    return NextResponse.json({ error: "invalid_step" }, { status: 400 });
  }
  if (session.completedMessSteps.includes(stepId)) {
    return NextResponse.json({ error: "step_already_executed" }, { status: 409 });
  }

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) {
    return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
  }

  try {
    const ctx: MessContext = {
      demo: Keypair.fromSecret(decryptSecret(session.encDemoSecret)),
      ephemeralIssuers: new Map(
        session.ephemeralIssuers.map((e) => [e.assetCode, Keypair.fromSecret(decryptSecret(e.encSecret))])
      ),
      persistentIssuer: issuer,
      mmPublic: mm.publicKey(),
      fundRareAssets: session.fundRareAssets,
      offerCount: session.offerCount,
      dataEntryCount: session.dataEntryCount,
    };

    // isMessStepId is a type predicate, so stepId is already narrowed to MessStepId here.
    const txHash = await executeMessStep(stepId, ctx);

    session.completedMessSteps.push(stepId);
    await saveSession(session);

    return NextResponse.json({ stepId, txHash });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[playground] mess step ${stepId} failed for session ${id}:`, err);
    return NextResponse.json({ error: "tx_failed", detail: message }, { status: 502 });
  }
}
