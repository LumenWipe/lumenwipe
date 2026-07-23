import { NextRequest, NextResponse } from "next/server";
import { checkNamespacedRateLimit } from "@/lib/kv";
import { decryptSecret, PlaygroundConfigError } from "@/lib/playground/crypto";
import { loadSession } from "@/lib/playground/session-server";

export const maxDuration = 10;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const allowed = await checkNamespacedRateLimit("playground:credentials", ip, 50);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

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
      console.error("[playground] misconfiguration:", err.message);
      return NextResponse.json(
        { error: "Playground is not configured on this server." },
        { status: 503 }
      );
    }
    throw err;
  }
}
