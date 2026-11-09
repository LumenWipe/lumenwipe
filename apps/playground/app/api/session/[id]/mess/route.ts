import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { actionResponse, notConfiguredResponse } from "@/lib/route-helpers";
import { runMessStep } from "@/lib/session-actions";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { executeMessStep } from "@/lib/mess-builders";
import { isMessStepId } from "@/lib/mess-plan";

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

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

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) return notConfiguredResponse();

  const result = await runMessStep(sessionStore, id, stepId, {
    executeStep: (step, session, recordSigner) =>
      executeMessStep(step, {
        demo: Keypair.fromSecret(decryptSecret(session.encDemoSecret)),
        ephemeralIssuers: new Map(
          session.ephemeralIssuers.map((e) => [
            e.assetCode,
            Keypair.fromSecret(decryptSecret(e.encSecret)),
          ])
        ),
        persistentIssuer: issuer,
        mmPublic: mm.publicKey(),
        fundRareAssets: session.fundRareAssets,
        offerCount: session.offerCount,
        dataEntryCount: session.dataEntryCount,
        recordSigner,
      }),
  });
  return actionResponse(result);
}
