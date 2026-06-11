import { openDB } from "idb";
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
  await db.put(STORE_NAME, { ...record, updatedAt: new Date().toISOString() });
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
