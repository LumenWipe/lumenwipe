import { getDb, HISTORY_STORE_NAME } from "./store";
import type { MergeHistoryEntry } from "@/types/history";

export async function saveHistory(entry: MergeHistoryEntry): Promise<void> {
  const db = await getDb();
  await db.put(HISTORY_STORE_NAME, entry);
}

export async function listHistory(): Promise<MergeHistoryEntry[]> {
  const db = await getDb();
  const entries: MergeHistoryEntry[] = await db.getAll(HISTORY_STORE_NAME);
  return entries.sort(
    (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
  );
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(HISTORY_STORE_NAME, id);
}
