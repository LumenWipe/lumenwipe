import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { buildSignSubmit } from "@/lib/mess-builders";
import { handleResolve } from "@/lib/route-handlers";

export const maxDuration = 60;

/** Resolves a blocker the session's plan expects, with a helper's key; see `handleResolve`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleResolve(req, id, {
    store: sessionStore,
    decrypt: decryptSecret,
    submit: (source, ops) => buildSignSubmit(source, ops),
  });
}
