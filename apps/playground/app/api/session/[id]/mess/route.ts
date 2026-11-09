import { NextRequest } from "next/server";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { executeMessStep } from "@/lib/mess-builders";
import { handleMess } from "@/lib/route-handlers";

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleMess(req, id, {
    store: sessionStore,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    encrypt: encryptSecret,
    decrypt: decryptSecret,
    executeMessStep,
  });
}
