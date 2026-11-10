import "server-only";
import { CloseOutcomeUnknownError, LumenWipeApiError, type AccountState } from "@lumenwipe/sdk";
import { RevokeAllowanceVerificationError, VerificationError } from "@lumenwipe/verify";
import { PlaygroundConfigError } from "./crypto";
import {
  DemolishBlockedError,
  DemolishDecisionUnanswerableError,
  DemolishDeliveryUnconfirmedError,
  DemolishFeeUnsponsoredError,
  type DemolishRoundHooks,
  type DemolishRoundResult,
} from "./demolish";
import type { ListedAllowance } from "./allowances";
import { BlendUtilizationError, LiquidityUnavailableError } from "./mess-builders";
import { RevokeVerificationError } from "./verify-revoke";
import {
  resolvePlan,
  type HelperRole,
  type MessStepDef,
  type MessStepId,
  type PlannedResolution,
  type ResolutionKind,
} from "./scenarios";
import {
  PlaygroundStoreUnavailableError,
  type DemolishLogEntry,
  type PlaygroundSession,
  type RecordedAllowance,
  type RecordedClaimableBalance,
  type RecordedSigner,
  type SessionLock,
  type SessionPatch,
  type SessionStore,
  isSessionId,
  logEntryOf,
} from "./session-store";

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

// Every failure is a bare code: upstream SDK, Horizon and API messages are logged server-side and
// never returned, and the client maps each code to its own plain-language copy.
export const NOT_CONFIGURED: ActionResult = { status: 503, body: { error: "not_configured" } };
const SESSION_NOT_FOUND: ActionResult = { status: 404, body: { error: "session_not_found" } };
const STEP_IN_PROGRESS: ActionResult = { status: 409, body: { error: "step_in_progress" } };
const STEP_NOT_IN_PLAN: ActionResult = { status: 400, body: { error: "step_not_in_plan" } };
const STEP_OUT_OF_ORDER: ActionResult = { status: 409, body: { error: "step_out_of_order" } };

/** How many unanswerable decision ids a refused round reports, and how much of each. */
const MAX_REPORTED_DECISIONS = 10;
const MAX_DECISION_ID_LENGTH = 200;

export interface MessStepDeps {
  /** `recordSigner` persists a signer the step is about to add, before its transaction is sent.
   *  Resolves to the step's transaction hash, or null when the step had nothing to send: the step
   *  is still recorded as done, and the response carries a null hash. */
  executeStep: (
    step: MessStepDef,
    session: PlaygroundSession,
    recordSigner: (signer: RecordedSigner) => Promise<void>,
    recordClaimableBalances: (balances: RecordedClaimableBalance[]) => Promise<void>,
    recordAllowance: (index: number, allowance: RecordedAllowance) => Promise<void>
  ) => Promise<string | null>;
}

export interface DemolishRoundDeps {
  /** Runs one round of the close (lib/demolish.ts `runCloseRound`). */
  round: (session: PlaygroundSession, hooks: DemolishRoundHooks) => Promise<DemolishRoundResult>;
}

export interface RecycleResult {
  /** Public keys merged into the market maker, or found already gone. */
  recycled: string[];
  /** Whether every account the session holds a key for is gone. */
  complete: boolean;
  /** Drops what was recycled from the record, for a cleanup that has to run again. */
  patch: SessionPatch;
}

export interface CleanupDeps {
  recycle: (session: PlaygroundSession) => Promise<RecycleResult>;
}

function isConfigError(err: unknown): boolean {
  return err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError;
}

/**
 * Runs `action` holding the session's exclusive lock. The demo account has one sequence number, so
 * any two actions on one session collide on chain; a second request gets `step_in_progress`. The
 * session is re-read after the lock is taken, so a request that read it before another finished
 * still sees that request's result.
 */
async function withSessionLock(
  store: SessionStore,
  id: string,
  action: (session: PlaygroundSession, lock: SessionLock) => Promise<ActionResult>
): Promise<ActionResult> {
  if (!isSessionId(id)) return SESSION_NOT_FOUND;
  if (!(await store.loadSession(id))) return SESSION_NOT_FOUND;
  const lock = await store.acquireLock(id);
  if (!lock) return STEP_IN_PROGRESS;
  try {
    const session = await store.loadSession(id);
    if (!session) return SESSION_NOT_FOUND;
    return await action(session, lock);
  } finally {
    await store.releaseLock(lock).catch((err: unknown) => {
      console.error("[playground] session lock release failed", { sessionId: id }, err);
    });
  }
}

export async function runMessStep(
  store: SessionStore,
  id: string,
  stepId: MessStepId,
  deps: MessStepDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session, lock) => {
      // The plan comes from the session's stored selection, never from the request: a step the
      // session did not select would build entries its close expectation does not allow for.
      const plan = resolvePlan(session.selection).steps;
      const step = plan.find((s) => s.id === stepId);
      if (!step) return STEP_NOT_IN_PLAN;
      if (session.completedMessSteps.includes(stepId)) {
        return { status: 409, body: { error: "step_already_executed" } };
      }
      // Each demolish round releases the lock, so a step could otherwise land between two rounds
      // of a close that has already started changing the account.
      if (demolishStarted(session)) {
        return { status: 409, body: { error: "demolish_started" } };
      }
      const next = plan.find((s) => !session.completedMessSteps.includes(s.id));
      if (next !== step) return STEP_OUT_OF_ORDER;
      // Recorded before the transaction is sent: a signer that never lands is harmless (removing
      // it would fail on chain), while one that lands unrecorded would make the demolish refuse.
      const recordSigner = async (signer: RecordedSigner): Promise<void> => {
        await store.updateSession(lock, (current) => ({
          recordedSigners: [...current.recordedSigners, signer],
        }));
      };
      // Recorded before each attempt is sent, replacing the last attempt's: a balance id is fixed by
      // the signed transaction, and only the one that lands creates balances.
      const recordClaimableBalances = async (
        balances: RecordedClaimableBalance[]
      ): Promise<void> => {
        await store.updateSession(lock, () => ({ claimableBalances: balances }));
      };
      // Recorded before each approve is sent: spender `index` is entry `index - 1`, and a retry of
      // the step replaces what its earlier attempt recorded for that spender.
      const recordAllowance = async (
        index: number,
        allowance: RecordedAllowance
      ): Promise<void> => {
        await store.updateSession(lock, (current) => {
          if (!Number.isInteger(index) || index < 1 || index > current.allowances.length + 1) {
            throw new Error(`Allowance ${index} recorded out of order`);
          }
          const allowances = [...current.allowances];
          allowances[index - 1] = allowance;
          return { allowances };
        });
      };
      const txHash = await deps.executeStep(
        step,
        session,
        recordSigner,
        recordClaimableBalances,
        recordAllowance
      );
      await store.updateSession(lock, (current) => ({
        completedMessSteps: [...current.completedMessSteps, stepId],
      }));
      return { status: 200, body: { stepId, txHash } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    // Refused before anything was signed for the step, so a later try can still run it.
    if (err instanceof LiquidityUnavailableError) {
      return { status: 503, body: { error: "testnet_liquidity_unavailable" } };
    }
    if (err instanceof BlendUtilizationError) {
      return { status: 503, body: { error: "testnet_lending_unavailable" } };
    }
    console.error("[playground] mess step failed", { stepId, sessionId: id }, err);
    return { status: 502, body: { error: "tx_failed" } };
  }
}

function demolishStarted(session: PlaygroundSession): boolean {
  return session.demolishDone || session.demolishPending !== null || session.demolishLog.length > 0;
}

/**
 * Runs one demolish round under the session lock and returns the transactions it confirmed. The
 * client calls again while `done` is false, and calling again after a failure is the resume: the
 * API re-reads live state, and a transaction left in flight is settled from `demolishPending`.
 *
 * Every write goes through one chain, so writes land in order and none is lost to another's
 * read-modify-write. A confirmed transaction's log entry, the clearing of its in-flight record and,
 * for the merge, the done flag are one write: an interrupted request leaves either the record (the
 * next round settles it by hash and logs it then) or the entry, never both and never neither.
 */
export async function runDemolishRound(
  store: SessionStore,
  id: string,
  deps: DemolishRoundDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session, lock) => {
      if (session.demolishDone) {
        return { status: 200, body: { done: true, confirmed: [], remainingSteps: 0 } };
      }
      const logStart = session.demolishLog.length;
      let latest = session;
      let writes: Promise<void> = Promise.resolve();
      const write = (patch: (current: PlaygroundSession) => SessionPatch): Promise<void> => {
        const next = writes
          .then(() => store.updateSession(lock, patch))
          .then((written) => {
            latest = written;
          });
        writes = next.catch(() => undefined);
        return next;
      };
      // What became of the in-flight record (the left-over one, or the last one written). Read only
      // once the round ends, so the order the engine reports a settlement and a confirmation in
      // does not matter: a record that settled without confirming is cleared then, while a
      // confirmed one is cleared by its own log write, or kept for the next round if that failed.
      let settled = false;
      let confirmed = false;

      const hooks: DemolishRoundHooks = {
        pending: session.demolishPending,
        persistPending: async (pending) => {
          settled = false;
          confirmed = false;
          await write(() => ({ demolishPending: pending }));
        },
        settled: () => {
          settled = true;
        },
        onConfirmed: (entry, closesAccount) => {
          confirmed = true;
          write((current) => ({
            demolishLog: [...current.demolishLog, entry],
            demolishPending: null,
            ...(closesAccount && { demolishDone: true }),
          })).catch((err: unknown) => {
            // The record stays in flight, so the next round settles the transaction and logs it.
            console.error("[playground] demolish log update failed", { sessionId: id }, err);
          });
        },
      };

      let result: DemolishRoundResult;
      try {
        result = await deps.round(session, hooks);
      } finally {
        await writes;
        if (settled && !confirmed) {
          await write(() => ({ demolishPending: null })).catch((err: unknown) => {
            console.error("[playground] demolish pending clear failed", { sessionId: id }, err);
          });
        }
      }
      if (result.done && !latest.demolishDone) {
        // The merge confirmed under the playground's own hash but its log write failed, so its
        // in-flight record is still there: it is the merge, and is logged from it now.
        await write((current) => ({
          demolishLog: current.demolishPending
            ? [...current.demolishLog, logEntryOf(current.demolishPending)]
            : current.demolishLog,
          demolishPending: null,
          demolishDone: true,
        }));
      }
      return {
        status: 200,
        body: {
          done: result.done,
          confirmed: latest.demolishLog.slice(logStart),
          remainingSteps: result.remainingSteps,
        },
      };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    if (err instanceof DemolishBlockedError) {
      // Codes only: the API's messages are not shown. `resolvable` names the blockers the
      // session's own plan has a resolution for, read from the stored selection.
      const blockers = [...new Set(err.blockers)]
        .slice(0, MAX_REPORTED_DECISIONS)
        .map((code) => code.slice(0, MAX_DECISION_ID_LENGTH));
      const planned = await plannedResolutions(store, id);
      return {
        status: 422,
        body: {
          error: "demolish_blocked",
          blockers,
          resolvable: blockers.filter((code) => planned.includes(code)),
        },
      };
    }
    if (err instanceof DemolishDecisionUnanswerableError) {
      // Nothing was built or signed. The ids come from the API's plan, so they are bounded before
      // they are returned; the page shows them as text.
      return {
        status: 422,
        body: {
          error: "demolish_decision_unanswerable",
          decisions: err.decisionIds
            .slice(0, MAX_REPORTED_DECISIONS)
            .map((decisionId) => decisionId.slice(0, MAX_DECISION_ID_LENGTH)),
        },
      };
    }
    if (err instanceof DemolishFeeUnsponsoredError) {
      // Nothing was sent. The API's code is logged, never returned.
      console.warn("[playground] demolish fee not sponsored", { sessionId: id, code: err.code });
      return { status: 502, body: { error: "demolish_fee_unsponsored" } };
    }
    if (err instanceof DemolishDeliveryUnconfirmedError) {
      // The merge landed; only its read-back did not show the deposit. The code is logged only.
      console.error("[playground] exchange deposit not confirmed", {
        sessionId: id,
        code: err.code,
      });
      return { status: 502, body: { error: "demolish_delivery_unconfirmed" } };
    }
    console.error("[playground] demolish round failed", { sessionId: id }, err);
    const error =
      err instanceof CloseOutcomeUnknownError ? "demolish_outcome_unknown" : "demolish_failed";
    return { status: 502, body: { error } };
  }
}

/** The blocker codes the session's stored selection plans a resolution for. */
async function plannedResolutions(store: SessionStore, id: string): Promise<string[]> {
  const session = await store.loadSession(id).catch(() => null);
  if (!session) return [];
  return resolvePlan(session.selection).expectation.resolutions.map((r) => r.blocker);
}

export interface RevokeAllowanceDeps {
  /** Lists the demo's allowances through the API. */
  list: (session: PlaygroundSession) => Promise<ListedAllowance[]>;
  /** Revokes one recorded allowance once both checks accept the API's transaction; its hash. */
  revoke: (session: PlaygroundSession, allowance: RecordedAllowance) => Promise<string>;
}

/** The session's recorded allowances beside the API's list; read only, so no lock is taken. */
export async function readSessionAllowances(
  session: PlaygroundSession,
  deps: Pick<RevokeAllowanceDeps, "list">
): Promise<ActionResult> {
  if (session.allowances.length === 0) return { status: 200, body: { allowances: [] } };
  try {
    return { status: 200, body: { allowances: await deps.list(session) } };
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error("[playground] allowance list failed", { sessionId: session.id }, err);
    return { status: 502, body: { error: "allowances_read_failed" } };
  }
}

/**
 * Revokes one allowance the session recorded, named by its spender, under the session lock: the
 * API builds the revoke, both checks hold it to the record, and the demo key signs it. Refused
 * for a spender the session did not record, and once the close has merged the demo or has a
 * transaction in flight.
 */
export async function runRevokeAllowance(
  store: SessionStore,
  id: string,
  spender: string,
  deps: Pick<RevokeAllowanceDeps, "revoke">
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session) => {
      const allowance = session.allowances.find((a) => a.spender === spender);
      if (!allowance) return { status: 400, body: { error: "allowance_not_recorded" } };
      if (session.demolishDone || session.demolishPending !== null) {
        return { status: 409, body: { error: "demolish_in_progress" } };
      }
      const txHash = await deps.revoke(session, allowance);
      return { status: 200, body: { spender, txHash } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error("[playground] allowance revoke failed", { sessionId: id }, err);
    // Refused by a check before anything was signed: asking again gets the same transaction.
    const refused =
      err instanceof RevokeVerificationError ||
      err instanceof RevokeAllowanceVerificationError ||
      err instanceof VerificationError;
    return refused
      ? { status: 422, body: { error: "revoke_refused" } }
      : { status: 502, body: { error: "revoke_failed" } };
  }
}

export interface ResolveDeps {
  /** Sends the resolution's transaction with the helper's key; returns its hash. */
  resolve: (session: PlaygroundSession, resolution: PlannedResolution) => Promise<string>;
}

/** The mess step that creates what each resolution acts on. */
const RESOLUTION_STEP: Record<ResolutionKind, MessStepId> = {
  claim_sponsored_balance: "CLAIMABLE_BALANCES",
  release_sponsored_entries: "SPONSORED_ENTRIES",
};

const RESOLUTION_HELPER: Record<ResolutionKind, HelperRole> = {
  claim_sponsored_balance: "claimant",
  release_sponsored_entries: "beneficiary",
};

/** Whether the session recorded what the resolution needs: its step ran and its helper exists. */
function resolutionRecorded(session: PlaygroundSession, kind: ResolutionKind): boolean {
  if (!session.completedMessSteps.includes(RESOLUTION_STEP[kind])) return false;
  if (!session.helperAccounts.some((h) => h.role === RESOLUTION_HELPER[kind])) return false;
  return (
    kind !== "claim_sponsored_balance" ||
    session.claimableBalances.some((b) => b.intent === "demo_sponsored")
  );
}

/**
 * Resolves a blocker the session's plan expects the close to report, with the helper's own key,
 * under the session lock. Only a resolution the stored selection planned, only once the step it
 * acts on has run, and never while a close transaction is in flight.
 */
export async function runResolve(
  store: SessionStore,
  id: string,
  blocker: string,
  deps: ResolveDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session) => {
      const resolution = resolvePlan(session.selection).expectation.resolutions.find(
        (r) => r.blocker === blocker
      );
      if (!resolution) return { status: 400, body: { error: "resolution_unavailable" } };
      if (session.demolishDone || session.demolishPending !== null) {
        return { status: 409, body: { error: "demolish_in_progress" } };
      }
      if (!resolutionRecorded(session, resolution.kind)) {
        return { status: 409, body: { error: "resolution_not_recorded" } };
      }
      const txHash = await deps.resolve(session, resolution);
      return { status: 200, body: { ok: true, blocker, txHash } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error("[playground] resolution failed", { sessionId: id }, err);
    return { status: 502, body: { error: "resolve_failed" } };
  }
}

/**
 * Recycles the session's accounts under the same lock as every step, and deletes the record only
 * once all of them are gone: the record holds the only copy of their keys, so a cleanup that
 * stops part way keeps it, without what it did recycle, for the next attempt.
 */
export async function runCleanup(
  store: SessionStore,
  id: string,
  deps: CleanupDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session, lock) => {
      const { recycled, complete, patch } = await deps.recycle(session);
      if (!complete) {
        await store.updateSession(lock, () => patch);
        return { status: 502, body: { error: "cleanup_failed" } };
      }
      await store.deleteSession(lock);
      return { status: 200, body: { ok: true, recycled } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error("[playground] cleanup failed", { sessionId: id }, err);
    return { status: 502, body: { error: "cleanup_failed" } };
  }
}

export interface StateDeps {
  getAccount: (publicKey: string) => Promise<AccountState>;
}

export async function readSessionState(
  session: PlaygroundSession,
  deps: StateDeps
): Promise<ActionResult> {
  const progress = {
    demoPublic: session.demoPublic,
    completedMessSteps: session.completedMessSteps,
    demolishLog: session.demolishLog,
    demolishDone: session.demolishDone,
  };
  try {
    const accountState = await deps.getAccount(session.demoPublic);
    return { status: 200, body: { ...progress, accountState } };
  } catch (err) {
    if (err instanceof LumenWipeApiError && err.status === 404) {
      // The demo account no longer exists once the merge lands - that's success, not an error.
      return { status: 200, body: { ...progress, accountState: null } };
    }
    console.error("[playground] account state read failed", { sessionId: session.id }, err);
    return { status: 502, body: { error: "state_read_failed" } };
  }
}
