import type { Network } from "@/config/networks";
import { loadSession, saveSession } from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";

/** Saves the close this tab holds as a resumable session, under the session id it already has. */
export async function saveCloseSession(network: Network): Promise<void> {
  const state = useDemolishStore.getState();
  if (!state.sessionId) state.initSession();
  const { sessionId, sourceAddress, destinationAddress, memo, memoType, mediatorRequired } =
    useDemolishStore.getState();
  if (!sessionId || !sourceAddress || !destinationAddress) return;
  const now = new Date().toISOString();
  await saveSession({
    id: sessionId,
    network,
    sourceAddress,
    destinationAddress,
    memo,
    memoType,
    mediatorRequired,
    completedSteps: [],
    currentStepIndex: 0,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });
}

/** Puts back a session record another tab dismissed while this one still holds the close. */
export async function ensureCloseSession(network: Network): Promise<void> {
  const { sessionId } = useDemolishStore.getState();
  if (!sessionId || !(await loadSession(sessionId))) await saveCloseSession(network);
}
