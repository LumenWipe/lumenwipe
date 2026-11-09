import { NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { ensureMmOffer } from "@/lib/mess-builders";
import { handleCreateSession } from "@/lib/route-handlers";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

const FRIENDBOT = "https://friendbot.stellar.org";

async function fundWithFriendbot(publicKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  return handleCreateSession(req, {
    store: sessionStore,
    rateLimit,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    fundAccount: fundWithFriendbot,
    ensureMmOffer,
    encrypt: encryptSecret,
  });
}
