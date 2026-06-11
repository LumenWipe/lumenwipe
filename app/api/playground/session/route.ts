import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { checkNamespacedRateLimit } from "@/lib/kv";
import { encryptSecret, PlaygroundConfigError } from "@/lib/playground/crypto";
import {
  createSession,
  sessionExpiresAt,
  PlaygroundStoreUnavailableError,
} from "@/lib/playground/session-server";
import {
  getPlaygroundIssuerKeypair,
  getPlaygroundMmKeypair,
} from "@/lib/playground/accounts-server";
import { ensureMmOffer } from "@/lib/playground/mess-builders";
import { EPHEMERAL_ASSETS, LWDEMO_CODE, MESS_PLAN } from "@/lib/playground/mess-plan";

export const maxDuration = 60;

const FRIENDBOT = "https://friendbot.stellar.org";
const SESSIONS_PER_DAY_PER_IP = 25;

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const allowed = await checkNamespacedRateLimit("playground", ip, SESSIONS_PER_DAY_PER_IP);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) {
    return NextResponse.json(
      { error: "Playground is not configured on this server." },
      { status: 503 }
    );
  }

  const demo = Keypair.random();
  const ephemeral = EPHEMERAL_ASSETS.map(({ code }) => ({
    assetCode: code,
    keypair: Keypair.random(),
  }));

  try {
    const fbRes = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(demo.publicKey())}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!fbRes.ok) {
      console.error(`[playground] friendbot failed (${fbRes.status}): ${await fbRes.text()}`);
      return NextResponse.json({ error: "friendbot_failed" }, { status: 502 });
    }
  } catch (err) {
    console.error("[playground] friendbot request failed:", err);
    return NextResponse.json({ error: "friendbot_failed" }, { status: 502 });
  }

  try {
    await ensureMmOffer(mm, issuer.publicKey());
  } catch (err) {
    // Non-fatal: the demo degrades to the send-to-issuer fallback.
    console.error("[playground] MM offer self-healing failed:", err);
  }

  try {
    const session = await createSession({
      demoPublic: demo.publicKey(),
      encDemoSecret: encryptSecret(demo.secret()),
      ephemeralIssuers: ephemeral.map((e) => ({
        publicKey: e.keypair.publicKey(),
        encSecret: encryptSecret(e.keypair.secret()),
        assetCode: e.assetCode,
      })),
      completedMessSteps: [],
      signCount: 0,
    });

    return NextResponse.json({
      sessionId: session.id,
      demoPublic: session.demoPublic,
      expiresAt: sessionExpiresAt(),
      messPlan: MESS_PLAN,
      accounts: {
        issuer: issuer.publicKey(),
        mm: mm.publicKey(),
        lwdemoAsset: `${LWDEMO_CODE}:${issuer.publicKey()}`,
        ephemeral: ephemeral.map((e) => ({ code: e.assetCode, publicKey: e.keypair.publicKey() })),
      },
    });
  } catch (err) {
    if (err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError) {
      console.error("[playground] misconfiguration:", err.message);
      return NextResponse.json(
        { error: "Playground is not configured on this server." },
        { status: 503 }
      );
    }
    throw err;
  }
}
