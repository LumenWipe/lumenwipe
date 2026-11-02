import { openDB } from "idb";
import type { UnresolvedSubmission } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import type { SessionRecord } from "@/types/session";

const DB_NAME = "lumenwipe";
const STORE_NAME = "sessions";
export const HISTORY_STORE_NAME = "history";
const DB_VERSION = 2;

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

export async function saveSession(record: SessionRecord): Promise<void> {
  const db = await getDb();
  const prior = (await db.get(STORE_NAME, record.id)) as SessionRecord | undefined;
  const unconfirmed = record.unconfirmed ?? prior?.unconfirmed;
  await db.put(STORE_NAME, {
    ...record,
    ...(unconfirmed && { unconfirmed }),
    updatedAt: new Date().toISOString(),
  });
}

/** Keeps a session's unconfirmed hash across a refresh, or drops it once settled. */
export async function saveUnconfirmed(
  id: string,
  submission: UnresolvedSubmission | null
): Promise<void> {
  const db = await getDb();
  const record = (await db.get(STORE_NAME, id)) as SessionRecord | undefined;
  if (!record) return;
  const { unconfirmed: _dropped, ...rest } = record;
  const kept = submission
    ? {
        unconfirmed: {
          hash: submission.hash,
          covers: submission.covers,
          validUntil: submission.validUntil,
        },
      }
    : {};
  await db.put(STORE_NAME, { ...rest, ...kept, updatedAt: new Date().toISOString() });
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
  return (await db.get(STORE_NAME, id)) ?? null;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await getDb();
  return db.getAll(STORE_NAME);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}
