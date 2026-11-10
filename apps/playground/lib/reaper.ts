import "server-only";
import type { NativeBalance } from "./horizon-submit";
import { MM_TOP_UP_BELOW_XLM, spendableXlm, type TopUpResult } from "./market-maker";
import {
  runCleanup,
  runDemolishRound,
  runResolve,
  runRevokeAllowance,
  type CleanupDeps,
  type DemolishRoundDeps,
  type ResolveDeps,
  type RevokeAllowanceDeps,
} from "./session-actions";
import type { PlaygroundSession, SessionStore } from "./session-store";

// The scheduled reaper. It reclaims what visitors leave behind (a closed tab, an error nobody
// resumed) through the same locked actions a visitor's requests use, so it never races one, then
// tops the market maker up and refills its standing offers. Vercel's Hobby plan runs it once a
// day and does not retry a failed run, so every step is idempotent and a session it cannot finish
// is simply tried again the next day.

/** A session younger than this may still have a visitor on it: twice the on-screen countdown. */
export const REAP_AFTER_MS = 2 * 3600 * 1000;
/** Most close rounds the reaper runs for one session in one run. */
export const MAX_ROUNDS_PER_SESSION = 12;
/** Time the run spends on sessions, leaving the rest of the function's 300 s for the top-up. */
export const SESSION_BUDGET_MS = 180_000;
/** Longer than the route's maxDuration, so a duplicate delivery of the same run does nothing. */
const REAPER_LEASE_TTL_MS = 330_000;

export interface ReaperDeps {
  store: SessionStore;
  now: () => number;
  round: DemolishRoundDeps;
  resolve: ResolveDeps;
  /** Revokes one recorded allowance through the API, held to both revoke checks. */
  revoke: Pick<RevokeAllowanceDeps, "revoke">;
  cleanup: CleanupDeps;
  /** Whether the account is on the network; false only when Horizon says it is not. */
  exists: (publicKey: string) => Promise<boolean>;
  /** Whether the session's close expectation can be built, so every transaction can be checked. */
  verifiable: (session: PlaygroundSession) => boolean;
  marketMakerBalance: () => Promise<NativeBalance>;
  topUp: () => Promise<TopUpResult>;
  refillLiquidity: () => Promise<void>;
}

export interface ReaperSummary {
  skipped: boolean;
  reaped: number;
  kept: number;
  young: number;
  pruned: number;
  deferred: number;
  topUp: TopUpResult | "not_needed" | "failed" | null;
  liquidity: "ok" | "failed" | null;
}

type SessionOutcome = "reaped" | "kept";

// Public keys and error codes only: no key, encrypted or not, and no upstream message.
const log = (message: string, session: PlaygroundSession, detail: Record<string, unknown>) =>
  console.warn("[playground] reaper", {
    message,
    sessionId: session.id,
    demo: session.demoPublic,
    ...detail,
  });

/** Runs the close until the demo is merged, or stops it for this run. True once it is merged. */
async function closeDemo(
  session: PlaygroundSession,
  deps: ReaperDeps,
  deadline: number
): Promise<boolean> {
  if (!deps.verifiable(session)) {
    log("close refused, the session's plan cannot be verified", session, {});
    return false;
  }
  const tried = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS_PER_SESSION; round++) {
    if (deps.now() >= deadline) return false;
    const result = await runDemolishRound(deps.store, session.id, deps.round);
    if (result.status === 200) {
      if (result.body.done === true) return true;
      continue;
    }
    const error = result.body.error;
    const resolvable = Array.isArray(result.body.resolvable)
      ? result.body.resolvable.filter((b): b is string => typeof b === "string" && !tried.has(b))
      : [];
    if (error !== "demolish_blocked" || resolvable.length === 0) {
      // A verifier refusal, an unanswerable decision, a held lock or a blocker with no fix: none
      // changes by asking again in this run.
      log("close stopped", session, { error });
      return false;
    }
    for (const blocker of resolvable) {
      tried.add(blocker);
      const resolved = await runResolve(deps.store, session.id, blocker, deps.resolve);
      if (resolved.status !== 200) {
        log("resolution failed", session, { blocker, error: resolved.body.error });
        return false;
      }
    }
  }
  log("close not finished within this run's rounds", session, {});
  return false;
}

/**
 * Revokes every allowance the session recorded, through the same locked action and the same two
 * checks as the visitor's page, before the close: the API's close plans no revoke (an allowance
 * lives in the token contract's storage, not on the account, so it never blocks the merge), so
 * nothing else would. One the page already revoked is revoked again, which only sets zero again.
 * Skipped once the close is in flight: the close comes first then, and the revokes are left.
 */
async function revokeRecorded(
  session: PlaygroundSession,
  deps: ReaperDeps,
  deadline: number
): Promise<boolean> {
  if (session.demolishPending !== null) return true;
  for (const { spender } of session.allowances) {
    if (deps.now() >= deadline) return false;
    const revoked = await runRevokeAllowance(deps.store, session.id, spender, deps.revoke);
    if (revoked.status !== 200) {
      log("allowance revoke failed", session, { error: revoked.body.error });
      return false;
    }
  }
  return true;
}

async function reapSession(
  session: PlaygroundSession,
  deps: ReaperDeps,
  deadline: number
): Promise<SessionOutcome> {
  // A finished close is never run again and its demo key never used: only the cleanup the
  // visitor's page did not get to is left. A transaction left in flight is settled by the close
  // before anything else, and a demo that does not exist (never funded) needs no close.
  if (!session.demolishDone) {
    const needsClose = session.demolishPending !== null || (await deps.exists(session.demoPublic));
    if (needsClose && !(await revokeRecorded(session, deps, deadline))) return "kept";
    if (needsClose && !(await closeDemo(session, deps, deadline))) return "kept";
  }
  const cleaned = await runCleanup(deps.store, session.id, deps.cleanup);
  if (cleaned.status === 200) return "reaped";
  log("cleanup not finished", session, { error: cleaned.body.error });
  return "kept";
}

export async function runReaper(deps: ReaperDeps): Promise<ReaperSummary> {
  const summary: ReaperSummary = {
    skipped: false,
    reaped: 0,
    kept: 0,
    young: 0,
    pruned: 0,
    deferred: 0,
    topUp: null,
    liquidity: null,
  };
  const lease = await deps.store.acquireLease("reaper", REAPER_LEASE_TTL_MS);
  if (!lease) return { ...summary, skipped: true };
  try {
    const deadline = deps.now() + SESSION_BUDGET_MS;
    for (const id of await deps.store.indexedSessionIds()) {
      if (deps.now() >= deadline) {
        summary.deferred++;
        continue;
      }
      try {
        const session = await deps.store.loadSession(id);
        if (!session) {
          await deps.store.unindexSession(id);
          summary.pruned++;
        } else if (deps.now() - session.createdAt < REAP_AFTER_MS) {
          summary.young++;
        } else {
          summary[await reapSession(session, deps, deadline)]++;
        }
      } catch (err) {
        summary.kept++;
        console.error("[playground] reaper: session failed", {
          sessionId: id,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    try {
      const low = spendableXlm(await deps.marketMakerBalance()) < MM_TOP_UP_BELOW_XLM;
      summary.topUp = low ? await deps.topUp() : "not_needed";
    } catch (err) {
      summary.topUp = "failed";
      console.error("[playground] reaper: top-up failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    try {
      await deps.refillLiquidity();
      summary.liquidity = "ok";
    } catch (err) {
      summary.liquidity = "failed";
      console.error("[playground] reaper: liquidity refill failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    return summary;
  } finally {
    await deps.store.releaseLease(lease).catch(() => undefined);
  }
}
