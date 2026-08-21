import { NextRequest, NextResponse } from "next/server";
import { decryptSecret, PlaygroundConfigError } from "@/lib/crypto";
import { loadSession } from "@/lib/session-store";

export const maxDuration = 10;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  try {
    const secretKey = decryptSecret(session.encDemoSecret);
    return NextResponse.json({ publicKey: session.demoPublic, secretKey });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
    }
    throw err;
  }
}
