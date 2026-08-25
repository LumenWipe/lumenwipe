import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { encryptSecret, PlaygroundConfigError } from "@/lib/crypto";
import {
  createSession,
  sessionExpiresAt,
  PlaygroundStoreUnavailableError,
} from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { ensureMmOffer } from "@/lib/mess-builders";
import {
  DEFAULT_CUSTOM_CONFIG,
  LWDEMO_CODE,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
  getFundRareAssets,
  getMessPlanForMode,
  getNeededEphemeralCodes,
  maxOfferCount,
} from "@/lib/mess-plan";
import { rateLimit, SESSIONS_PER_DAY_PER_IP } from "@/lib/rate-limit";

export const maxDuration = 60;

const FRIENDBOT = "https://friendbot.stellar.org";

export async function POST(req: NextRequest) {
  // Each session Friendbot-funds a fresh testnet account, spawns ephemeral issuers, and writes
  // a custodial session to KV. Anonymous and unbounded, that is an open faucet drain.
  const limited = await rateLimit(req, "session", SESSIONS_PER_DAY_PER_IP);
  if (limited) return limited;

  const issuer = getPlaygroundIssuerKeypair();
  const mm = getPlaygroundMmKeypair();
  if (!issuer || !mm) {
    return NextResponse.json(
      { error: "Playground is not configured on this server." },
      { status: 503 }
    );
  }

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
    mode === "light" ? 0 : mode === "standard" ? 3 : mode === "full" ? 5 : customConfig.offerCount;
  const dataEntryCount =
    mode === "light" ? 0 : mode === "standard" || mode === "full" ? 3 : customConfig.dataEntryCount;

  const demo = Keypair.random();
  const ephemeral = neededCodes.map((code) => ({ assetCode: code, keypair: Keypair.random() }));

  try {
    const fbRes = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(demo.publicKey())}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!fbRes.ok) {
      return NextResponse.json({ error: "friendbot_failed" }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "friendbot_failed" }, { status: 502 });
  }

  try {
    await ensureMmOffer(mm, issuer.publicKey());
  } catch (err) {
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
      demolishLog: [],
      demolishDone: false,
      fundRareAssets,
      offerCount,
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
        ephemeral: ephemeral.map((e) => ({ code: e.assetCode, publicKey: e.keypair.publicKey() })),
      },
    });
  } catch (err) {
    if (err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError) {
      return NextResponse.json(
        { error: "Playground is not configured on this server." },
        { status: 503 }
      );
    }
    throw err;
  }
}
