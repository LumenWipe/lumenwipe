import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { handleCredentials } from "@/lib/route-handlers";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 10;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCredentials(req, id, { store: sessionStore, rateLimit, decrypt: decryptSecret });
}
