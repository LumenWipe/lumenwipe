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
import {
  DEFAULT_CUSTOM_CONFIG,
  LWDEMO_CODE,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
  getFundRareAssets,
  getMessPlanForMode,
  getNeededEphemeralCodes,
  maxOfferCount,
} from "@/lib/playground/mess-plan";

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

  // Parse optional mode + custom config; default to "standard".
  let mode: PlaygroundMode = "standard";
  let customConfig: PlaygroundCustomConfig = DEFAULT_CUSTOM_CONFIG;
  try {
    const body = (await req.json()) as { mode?: unknown; customConfig?: unknown };
    if (
      body.mode === "light" ||
      body.mode === "standard" ||
      body.mode === "full" ||
      body.mode === "custom"
    ) {
      mode = body.mode;
    }
    if (mode === "custom" && body.customConfig && typeof body.customConfig === "object") {
      const c = body.customConfig as Record<string, unknown>;
      const tc =
        typeof c.trustlineCount === "number"
          ? Math.max(1, Math.min(5, c.trustlineCount))
          : DEFAULT_CUSTOM_CONFIG.trustlineCount;
      const maxOc = maxOfferCount(tc);
      customConfig = {
        trustlineCount: tc,
        offerCount:
          typeof c.offerCount === "number"
            ? Math.max(0, Math.min(maxOc, c.offerCount))
            : Math.min(DEFAULT_CUSTOM_CONFIG.offerCount, maxOc),
        dataEntryCount:
          typeof c.dataEntryCount === "number"
            ? Math.max(0, Math.min(5, c.dataEntryCount))
            : DEFAULT_CUSTOM_CONFIG.dataEntryCount,
        addSigner: typeof c.addSigner === "boolean" ? c.addSigner : DEFAULT_CUSTOM_CONFIG.addSigner,
      };
    }
  } catch {
    // Malformed or absent body - use defaults.
  }

  const neededCodes = getNeededEphemeralCodes(mode, customConfig);
  const fundRareAssets = getFundRareAssets(mode, customConfig);
  const offerCount =
    mode === "light" ? 0 : mode === "standard" || mode === "full" ? 3 : customConfig.offerCount;
  const dataEntryCount =
    mode === "light" ? 0 : mode === "standard" || mode === "full" ? 3 : customConfig.dataEntryCount;

  const demo = Keypair.random();
  const ephemeral = neededCodes.map((code) => ({ assetCode: code, keypair: Keypair.random() }));

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
      fundRareAssets,
      offerCount: mode === "full" ? 5 : offerCount,
      dataEntryCount,
    });

    return NextResponse.json({
      sessionId: session.id,
      demoPublic: session.demoPublic,
      expiresAt: sessionExpiresAt(),
      messPlan: getMessPlanForMode(mode, customConfig),
      accounts: {
        issuer: issuer.publicKey(),
        mm: mm.publicKey(),
        lwdemoAsset: `${LWDEMO_CODE}:${issuer.publicKey()}`,
        ephemeral: ephemeral.map((e) => ({
          code: e.assetCode,
          publicKey: e.keypair.publicKey(),
        })),
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
