import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { checkNamespacedRateLimit } from "@/lib/kv";
import { decryptSecret, PlaygroundConfigError } from "@/lib/playground/crypto";
import { loadSession, saveSession, MAX_SIGNS_PER_SESSION } from "@/lib/playground/session-server";
import {
  getPlaygroundIssuerKeypair,
  getPlaygroundMmKeypair,
} from "@/lib/playground/accounts-server";
import { validateSignRequest } from "@/lib/playground/validate-sign";

export const maxDuration = 30;

const SIGNS_PER_DAY_PER_IP = 200;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const allowed = await checkNamespacedRateLimit("playground:sign", ip, SIGNS_PER_DAY_PER_IP);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  if (session.signCount >= MAX_SIGNS_PER_SESSION) {
    return NextResponse.json({ error: "sign_quota_exceeded" }, { status: 429 });
  }

  let body: { transaction?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.transaction !== "string") {
    return NextResponse.json({ error: "missing_transaction" }, { status: 400 });
  }

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) {
    return NextResponse.json(
      { error: "Playground is not configured on this server." },
      { status: 503 }
    );
  }

  const result = validateSignRequest(body.transaction, {
    demoPublic: session.demoPublic,
    allowedDestinations: new Set([
      session.demoPublic,
      ...session.ephemeralIssuers.map((e) => e.publicKey),
      issuer.publicKey(),
      mm.publicKey(),
    ]),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const demoKeypair = Keypair.fromSecret(decryptSecret(session.encDemoSecret));
    result.tx.sign(demoKeypair);

    session.signCount += 1;
    await saveSession(session); // also refreshes the TTL

    return NextResponse.json({ transaction: result.tx.toEnvelope().toXDR("base64") });
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
