import { NextRequest, NextResponse } from "next/server";
import { decryptSecret, PlaygroundConfigError } from "@/lib/crypto";
import { loadSessionOrErrorResponse } from "@/lib/route-helpers";
import { rateLimit, CREDENTIALS_PER_DAY_PER_IP } from "@/lib/rate-limit";

export const maxDuration = 10;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // This route decrypts and hands back a secret key; unbounded, it is a free oracle over every
  // session id an attacker can guess or scrape.
  const limited = await rateLimit(req, "credentials", CREDENTIALS_PER_DAY_PER_IP);
  if (limited) return limited;

  const { id } = await params;
  const session = await loadSessionOrErrorResponse(id);
  if (session instanceof NextResponse) return session;

  try {
    const secretKey = decryptSecret(session.encDemoSecret);
    return NextResponse.json({ publicKey: session.demoPublic, secretKey });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return NextResponse.json(
        { error: "Playground is not configured on this server." },
        { status: 503 }
      );
    }
    throw err;
  }
}
