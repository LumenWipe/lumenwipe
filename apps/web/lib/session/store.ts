import { openDB } from "idb";
import type { UnresolvedSubmission } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import { RECORD_VERSION, type SessionRecord } from "@/types/session";

const DB_NAME = "lumenwipe";
const STORE_NAME = "sessions";
export const HISTORY_STORE_NAME = "history";
// The record shape is versioned inside each record, so a new field needs no database upgrade:
// bumping this blocks the open while an older tab still holds the database.
const DB_VERSION = 2;
/** How long a saved close stays resumable after it was last touched. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function getDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
      }
    },
  });
}

/** A saved close in the current shape, whatever version wrote it. */
export function normaliseSession(raw: SessionRecord): SessionRecord {
  const legacy = raw as Partial<SessionRecord> & Pick<SessionRecord, "id">;
  return {
    ...raw,
    version: RECORD_VERSION,
    memo: legacy.memo ?? null,
    memoType: legacy.memoType ?? null,
    mediatorRequired: legacy.mediatorRequired ?? false,
    completedSteps: legacy.completedSteps ?? [],
    currentStepIndex: legacy.currentStepIndex ?? 0,
    stepCount: legacy.stepCount ?? null,
    stepBase: legacy.stepBase ?? 0,
    status: legacy.status ?? "in_progress",
    createdAt: legacy.createdAt ?? legacy.updatedAt ?? new Date(0).toISOString(),
    updatedAt: legacy.updatedAt ?? legacy.createdAt ?? new Date(0).toISOString(),
  };
}

/** Saves a new session, or updates only the terms of an existing one: its destination, memo and
 *  the plan just confirmed, whose `stepCount` steps are counted after those already confirmed.
 *  Progress, creation time, status and an unconfirmed hash are never overwritten, and they are
 *  read in the same transaction, so a hash another tab saved a moment ago is kept. */
export async function saveSession(record: SessionRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const prior = (await tx.store.get(record.id)) as SessionRecord | undefined;
  const updatedAt = new Date().toISOString();
  const { destinationAddress, memo, memoType, mediatorRequired, stepCount } = record;
  const kept = prior ? normaliseSession(prior) : null;
  await tx.store.put(
    kept
      ? {
          ...kept,
          destinationAddress,
          memo,
          memoType,
          mediatorRequired,
          stepBase: kept.currentStepIndex,
          stepCount: stepCount === null ? kept.stepCount : kept.currentStepIndex + stepCount,
          updatedAt,
        }
      : { ...record, version: RECORD_VERSION, stepBase: 0, updatedAt }
  );
  await tx.done;
}

/** Keeps a session's unconfirmed hash across a refresh, or drops it once settled. False when the
 *  session is gone, so a caller about to send knows nothing was kept. Read and written in one
 *  transaction, so progress recorded a moment earlier is never put back to a stale copy. */
export async function saveUnconfirmed(
  id: string,
  submission: UnresolvedSubmission | null
): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const record = (await tx.store.get(id)) as SessionRecord | undefined;
  if (!record) {
    await tx.done;
    return false;
  }
  const { unconfirmed: _dropped, ...rest } = normaliseSession(record);
  const kept = submission
    ? {
        unconfirmed: {
          hash: submission.hash,
          covers: submission.covers,
          validUntil: submission.validUntil,
        },
      }
    : {};
  await tx.store.put({ ...rest, ...kept, updatedAt: new Date().toISOString() });
  await tx.done;
  return true;
}

export interface Confirmation {
  txHash: string;
  /** The step the transaction was for: the merge when it carries one. */
  type: string;
  closesAccount: boolean;
  /** The first plan step not yet confirmed, when the plan is still in hand. */
  currentStepIndex: number | null;
}

const CLOSING_STEPS = ["MERGE", "CLOSE_ACCOUNT"];

/** What a saved close keeps of a transaction confirmed for the steps it `covers`. */
export function confirmationOf(
  covers: readonly string[],
  txHash: string,
  currentStepIndex: number | null
): Confirmation {
  const closing = covers.find((type) => CLOSING_STEPS.includes(type));
  return {
    txHash,
    type: closing ?? covers[0] ?? "",
    closesAccount: closing !== undefined,
    currentStepIndex,
  };
}

/** Appends a confirmed transaction to a saved close, once per hash, and marks the close completed
 *  when it closed the account. False when the record is gone: it is never recreated here. */
export async function recordConfirmed(id: string, confirmation: Confirmation): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const prior = (await tx.store.get(id)) as SessionRecord | undefined;
  if (!prior) {
    await tx.done;
    return false;
  }
  const record = normaliseSession(prior);
  const now = new Date().toISOString();
  const known = record.completedSteps.some((s) => s.txHash === confirmation.txHash);
  await tx.store.put({
    ...record,
    completedSteps: known
      ? record.completedSteps
      : [
          ...record.completedSteps,
          {
            index: record.completedSteps.length,
            type: confirmation.type,
            txHash: confirmation.txHash,
            confirmedAt: now,
          },
        ],
    currentStepIndex:
      confirmation.currentStepIndex === null
        ? record.currentStepIndex
        : record.stepBase + confirmation.currentStepIndex,
    status: confirmation.closesAccount ? "completed" : record.status,
    updatedAt: now,
  });
  await tx.done;
  return true;
}

/** Deletes a session unless it holds an unconfirmed hash, read in the same transaction, so a hash
 *  another tab saved after this one loaded is never discarded. True when it was deleted. */
export async function deleteSettledSession(id: string): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const record = (await tx.store.get(id)) as SessionRecord | undefined;
  if (record?.unconfirmed) {
    await tx.done;
    return false;
  }
  await tx.store.delete(id);
  await tx.done;
  return true;
}

/** Drops the unconfirmed hash of every session of this account: it is settled, whoever kept it. */
export async function clearUnconfirmedFor(network: Network, source: string): Promise<void> {
  const sessions = await listSessions();
  const held = sessions.filter(
    (s) => s.network === network && s.sourceAddress === source && s.unconfirmed
  );
  await Promise.all(held.map((s) => saveUnconfirmed(s.id, null)));
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  const db = await getDb();
  const record = (await db.get(STORE_NAME, id)) as SessionRecord | undefined;
  return record ? normaliseSession(record) : null;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await getDb();
  const records = (await db.getAll(STORE_NAME)) as SessionRecord[];
  return records.map(normaliseSession);
}

/** Not touched for SESSION_MAX_AGE_MS. One holding an unconfirmed hash never expires: it waits
 *  for its own check, however old. */
export function isExpired(record: SessionRecord): boolean {
  return (
    !record.unconfirmed && new Date(record.updatedAt).getTime() < Date.now() - SESSION_MAX_AGE_MS
  );
}

/** Deletes every expired saved close, in one transaction. */
export async function expireSessions(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const records = (await tx.store.getAll()) as SessionRecord[];
  for (const record of records.map(normaliseSession)) {
    if (isExpired(record)) await tx.store.delete(record.id);
  }
  await tx.done;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}
