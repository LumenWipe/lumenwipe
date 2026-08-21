import { NextRequest, NextResponse } from "next/server";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { deleteSession } from "@/lib/session-store";
import { loadSessionOrErrorResponse } from "@/lib/route-helpers";
import { getPlaygroundMmKeypair } from "@/lib/accounts";
import { buildSignSubmit } from "@/lib/mess-builders";

export const maxDuration = 60;

/**
 * Recycles the ephemeral issuer accounts (merges their ~3 XLM back into the
 * market maker) and deletes the session. Best-effort: failures are logged but
 * never block the caller - the XLM involved is testnet-only.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionOrErrorResponse(id);
  if (session instanceof NextResponse) return session;

  const mm = getPlaygroundMmKeypair();
  const recycled: string[] = [];

  if (mm) {
    for (const eph of session.ephemeralIssuers) {
      try {
        const kp = Keypair.fromSecret(decryptSecret(eph.encSecret));
        await buildSignSubmit(kp, [Operation.accountMerge({ destination: mm.publicKey() })]);
        recycled.push(eph.publicKey);
      } catch (err) {
        console.error(`[playground] cleanup merge failed for ${eph.publicKey}:`, err);
      }
    }
  }

  await deleteSession(id);
  return NextResponse.json({ ok: true, recycled });
}
