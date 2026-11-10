import { NextRequest } from "next/server";
import { Operation } from "@stellar/stellar-sdk";
import { encryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { accountExists, loadNativeBalance } from "@/lib/horizon-submit";
import { ensureAccountFromMarketMaker } from "@/lib/market-maker";
import { buildSignSubmit } from "@/lib/mess-builders";
import { handleCreateSession } from "@/lib/route-handlers";
import { rateLimit } from "@/lib/rate-limit";
import { unavailableScenarios } from "@/lib/scenario-availability";
import { EXCHANGE_STAND_IN_FUNDING_XLM } from "@/lib/scenarios";

export const maxDuration = 90;

const createAccount = (
  mm: Parameters<typeof buildSignSubmit>[0],
  destination: string,
  startingBalance: string
) => buildSignSubmit(mm, [Operation.createAccount({ destination, startingBalance })]);

export async function POST(req: NextRequest) {
  return handleCreateSession(req, {
    store: sessionStore,
    rateLimit,
    issuer: getPlaygroundIssuerKeypair,
    mm: getPlaygroundMmKeypair,
    cronSecret: () => process.env.CRON_SECRET,
    marketMakerBalance: loadNativeBalance,
    provisionDemo: createAccount,
    ensureExchangeAccount: (mm, address) =>
      ensureAccountFromMarketMaker(mm, address, EXCHANGE_STAND_IN_FUNDING_XLM, {
        exists: accountExists,
        create: createAccount,
      }),
    encrypt: encryptSecret,
    unavailable: unavailableScenarios,
  });
}
