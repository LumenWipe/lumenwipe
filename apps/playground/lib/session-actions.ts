import "server-only";
import { LumenWipeApiError, type AccountState, type IntentOperation } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "./crypto";
import type { MessStepId } from "./mess-plan";
import {
  PlaygroundStoreUnavailableError,
  type DemolishLogEntry,
  type PlaygroundSession,
  type SessionLock,
  type SessionStore,
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

export type OnDemolishConfirmed = (
  txId: string,
  hash: string,
  summary: string,
  operations: IntentOperation[]
) => void;

export interface MessStepDeps {
  executeStep: (stepId: MessStepId, session: PlaygroundSession) => Promise<string>;
}

export interface DemolishDeps {
  demolish: (session: PlaygroundSession, onConfirmed: OnDemolishConfirmed) => Promise<void>;
}

export interface CleanupDeps {
  recycle: (session: PlaygroundSession) => Promise<string[]>;
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
  if (!(await store.loadSession(id))) return SESSION_NOT_FOUND;
  const lock = await store.acquireLock(id);
  if (!lock) return STEP_IN_PROGRESS;
  try {
    const session = await store.loadSession(id);
    if (!session) return SESSION_NOT_FOUND;
    return await action(session, lock);
  } finally {
    await store.releaseLock(lock).catch((err: unknown) => {
      console.error(`[playground] session lock release failed for session ${id}:`, err);
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
      if (session.completedMessSteps.includes(stepId)) {
        return { status: 409, body: { error: "step_already_executed" } };
      }
      const txHash = await deps.executeStep(stepId, session);
      await store.updateSession(lock, (current) => ({
        completedMessSteps: [...current.completedMessSteps, stepId],
      }));
      return { status: 200, body: { stepId, txHash } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error(`[playground] mess step ${stepId} failed for session ${id}:`, err);
    return { status: 502, body: { error: "tx_failed" } };
  }
}

export async function runDemolishStep(
  store: SessionStore,
  id: string,
  deps: DemolishDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session, lock) => {
      if (session.demolishDone) return { status: 200, body: { done: true } };

      // Log appends are chained so they land in order and before the final update; a failed one
      // only leaves the progress log behind, it must not abort the close.
      let logWrites: Promise<void> = Promise.resolve();
      const onConfirmed: OnDemolishConfirmed = (txId, hash, summary, operations) => {
        const entry: DemolishLogEntry = { txId, hash, summary, operations };
        logWrites = logWrites
          .then(() =>
            store.updateSession(lock, (current) => ({
              demolishLog: [...current.demolishLog, entry],
            }))
          )
          .then(
            () => undefined,
            (err: unknown) => {
              console.error(`[playground] demolish log update failed for session ${id}:`, err);
            }
          );
      };

      try {
        await deps.demolish(session, onConfirmed);
      } finally {
        await logWrites;
      }
      await store.updateSession(lock, () => ({ demolishDone: true }));
      return { status: 200, body: { done: true } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error(`[playground] demolish failed for session ${id}:`, err);
    return { status: 502, body: { error: "demolish_failed" } };
  }
}

/** Recycles the ephemeral issuers and deletes the session, under the same lock as every step. */
export async function runCleanup(
  store: SessionStore,
  id: string,
  deps: CleanupDeps
): Promise<ActionResult> {
  try {
    return await withSessionLock(store, id, async (session, lock) => {
      const recycled = await deps.recycle(session);
      await store.deleteSession(lock);
      return { status: 200, body: { ok: true, recycled } };
    });
  } catch (err) {
    if (isConfigError(err)) return NOT_CONFIGURED;
    console.error(`[playground] cleanup failed for session ${id}:`, err);
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
    console.error(`[playground] account state read failed for session ${session.id}:`, err);
    return { status: 502, body: { error: "state_read_failed" } };
  }
}
