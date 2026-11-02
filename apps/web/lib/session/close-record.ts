import type { Network } from "@/config/networks";
import { loadSession, saveSession } from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";

/** The account a run of the close loop was started for. The loop outlives the page, so the store
 *  can move on to another account while it is still working. */
export interface CloseOwner {
  network: Network;
  source: string;
}

export function ownsStore(owner: CloseOwner): boolean {
  return (
    useNetworkStore.getState().network === owner.network &&
    useDemolishStore.getState().sourceAddress === owner.source
  );
}

/** Saves the close this tab holds as a resumable session and returns its id, or null when the
 *  store no longer holds this owner's close, in which case nothing is written. */
export async function saveCloseSession(owner: CloseOwner): Promise<string | null> {
  if (!ownsStore(owner)) return null;
  const state = useDemolishStore.getState();
  if (!state.sessionId) state.initSession();
  const { sessionId, destinationAddress, memo, memoType, mediatorRequired } =
    useDemolishStore.getState();
  if (!sessionId || !destinationAddress) return null;
  const now = new Date().toISOString();
  await saveSession({
    id: sessionId,
    network: owner.network,
    sourceAddress: owner.source,
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
  return sessionId;
}

/** The owner's session id, putting back a record another tab dismissed while this one still holds
 *  the close. Null when the store no longer holds this owner's close. */
export async function ensureCloseSession(owner: CloseOwner): Promise<string | null> {
  if (!ownsStore(owner)) return null;
  const { sessionId } = useDemolishStore.getState();
  if (sessionId && (await loadSession(sessionId))) return sessionId;
  return saveCloseSession(owner);
}
