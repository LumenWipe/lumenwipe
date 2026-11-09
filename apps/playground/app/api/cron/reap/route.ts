import { NextRequest } from "next/server";
import { Operation } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";
import { accountExists, loadNativeBalance } from "@/lib/horizon-submit";
import { callFriendbot, topUpMarketMaker, withAccountLock } from "@/lib/market-maker";
import { buildSignSubmit, ensureStandingLiquidity } from "@/lib/mess-builders";
import {
  cleanupActionDeps,
  demolishRoundDeps,
  handleReap,
  resolveActionDeps,
} from "@/lib/route-handlers";
import { expectationFromSession } from "@/lib/verify";

// Hobby allows 300 s at most; the reaper spends 180 s of it on sessions (lib/reaper.ts).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Scheduled once a day by vercel.json; Vercel sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: NextRequest) {
  return handleReap(req, {
    cronSecret: () => process.env.CRON_SECRET,
    reaper: () => {
      const mm = getPlaygroundMmKeypair();
      const issuer = getPlaygroundIssuerKeypair();
      const merge = (source: Parameters<typeof buildSignSubmit>[0], destination: string) =>
        buildSignSubmit(source, [Operation.accountMerge({ destination })]);
      const submit = (
        source: Parameters<typeof buildSignSubmit>[0],
        ops: Parameters<typeof buildSignSubmit>[1]
      ) => buildSignSubmit(source, ops);
      const round = demolishRoundDeps({
        mm: () => mm,
        issuer: () => issuer,
        api: () => ({
          apiUrl: process.env.LUMENWIPE_API_URL,
          apiKey: process.env.LUMENWIPE_API_KEY,
        }),
        decrypt: decryptSecret,
        runDemolish,
      });
      const cleanup = cleanupActionDeps({
        mm: () => mm,
        issuer: () => issuer,
        decrypt: decryptSecret,
        exists: accountExists,
        merge,
        submit,
      });
      if (!mm || !issuer || !round || !cleanup) return null;
      return {
        store: sessionStore,
        now: Date.now,
        round,
        resolve: resolveActionDeps({ decrypt: decryptSecret, submit }),
        cleanup,
        exists: accountExists,
        verifiable: (session) => {
          try {
            expectationFromSession(session, mm.publicKey(), issuer.publicKey());
            return true;
          } catch {
            return false;
          }
        },
        marketMakerBalance: () => loadNativeBalance(mm.publicKey()),
        topUp: () =>
          topUpMarketMaker({
            store: sessionStore,
            mmPublic: mm.publicKey(),
            faucet: callFriendbot,
            merge,
          }),
        refillLiquidity: () =>
          withAccountLock(sessionStore, mm.publicKey(), () =>
            ensureStandingLiquidity(mm, issuer.publicKey())
          ),
      };
    },
  });
}
