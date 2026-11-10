import { NextRequest } from "next/server";
import { Asset, Operation } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { runDemolish } from "@/lib/demolish";
import { sdkAllowanceApi } from "@/lib/allowances";
import { accountExists, loadNativeBalance, loadSignerState } from "@/lib/horizon-submit";
import { callFriendbot, topUpMarketMaker, withAccountLock } from "@/lib/market-maker";
import { buildSignSubmit, ensureStandingLiquidity } from "@/lib/mess-builders";
import {
  cleanupActionDeps,
  demolishRoundDeps,
  handleReap,
  resolveActionDeps,
  revokeActionDeps,
} from "@/lib/route-handlers";
import { DEMO_FEE_TOP_UP_XLM } from "@/lib/reaper";
import { expectationFromSession } from "@/lib/verify";
import { expectedFeeAccount } from "@/lib/verify-feebump";
import { expectedMediator } from "@/lib/verify-mediator";

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
      const api = () => ({
        apiUrl: process.env.LUMENWIPE_API_URL,
        apiKey: process.env.LUMENWIPE_API_KEY,
      });
      const round = demolishRoundDeps({
        mm: () => mm,
        issuer: () => issuer,
        api,
        feeAccount: expectedFeeAccount,
        mediatorKey: expectedMediator,
        decrypt: decryptSecret,
        runDemolish,
      });
      const revoke = revokeActionDeps({
        api,
        decrypt: decryptSecret,
        allowanceApi: sdkAllowanceApi,
        signerState: loadSignerState,
      });
      const cleanup = cleanupActionDeps({
        mm: () => mm,
        issuer: () => issuer,
        decrypt: decryptSecret,
        exists: accountExists,
        merge,
        submit,
      });
      if (!mm || !issuer || !round || !revoke || !cleanup) return null;
      return {
        store: sessionStore,
        now: Date.now,
        round,
        resolve: resolveActionDeps({ decrypt: decryptSecret, submit }),
        revoke,
        cleanup,
        exists: accountExists,
        verifiable: (session) => {
          try {
            expectationFromSession(
              session,
              mm.publicKey(),
              issuer.publicKey(),
              expectedFeeAccount()
            );
            return true;
          } catch {
            return false;
          }
        },
        marketMakerBalance: () => loadNativeBalance(mm.publicKey()),
        topUpDemo: (demoPublic) =>
          withAccountLock(sessionStore, mm.publicKey(), () =>
            buildSignSubmit(mm, [
              Operation.payment({
                destination: demoPublic,
                asset: Asset.native(),
                amount: DEMO_FEE_TOP_UP_XLM,
              }),
            ])
          ),
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
