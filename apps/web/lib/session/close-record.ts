import type { Network } from "@/config/networks";
import { loadSession, saveSession } from "@/lib/session/store";
import { SESSION_RECORD_VERSION } from "@/types/session";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";

/** The account a run of the close loop was started for. The loop outlives the page, so the store
 *  can move on to another account while it is still working. */
export interface CloseOwner {
  network: Network;
  source: string;
  /** The store's reset count when the run started: leaving the close ends the run's hold. */
  epoch: number;
}

/** The owner of the close the store holds now, for this account. */
export function closeOwner(network: Network, source: string): CloseOwner {
  return { network, source, epoch: useDemolishStore.getState().closeEpoch };
}

export function ownsStore(owner: CloseOwner): boolean {
  const state = useDemolishStore.getState();
  return (
    useNetworkStore.getState().network === owner.network &&
    state.sourceAddress === owner.source &&
    state.closeEpoch === owner.epoch
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
    version: SESSION_RECORD_VERSION,
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
