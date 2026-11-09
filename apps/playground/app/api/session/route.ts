import { NextRequest } from "next/server";
import { Operation } from "@stellar/stellar-sdk";
import { encryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { loadNativeBalance } from "@/lib/horizon-submit";
import { buildSignSubmit } from "@/lib/mess-builders";
import { handleCreateSession } from "@/lib/route-handlers";
import { rateLimit } from "@/lib/rate-limit";
import { unavailableScenarios } from "@/lib/scenario-availability";

export const maxDuration = 90;

export async function POST(req: NextRequest) {
  return handleCreateSession(req, {
    store: sessionStore,
    rateLimit,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    cronSecret: () => process.env.CRON_SECRET,
    marketMakerBalance: loadNativeBalance,
    provisionDemo: (mm, destination, startingBalance) =>
      buildSignSubmit(mm, [Operation.createAccount({ destination, startingBalance })]),
    encrypt: encryptSecret,
    unavailable: unavailableScenarios,
  });
}
