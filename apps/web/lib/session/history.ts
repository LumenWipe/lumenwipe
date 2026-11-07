import { getDb, HISTORY_STORE_NAME } from "./store";
import { RECORD_VERSION } from "@/types/session";
import type { LegacyHistoryEntry, ReceiptRecord } from "@/types/history";

type StoredEntry = ReceiptRecord | LegacyHistoryEntry;

/** A history entry in the current shape, whatever wrote it. An entry from before the version
 *  field is read with "not recorded" for what it lacks; the database itself is never upgraded. */
export function normaliseHistory(raw: StoredEntry): ReceiptRecord {
  if (!("version" in raw)) {
    return {
      version: RECORD_VERSION,
      id: raw.id,
      network: raw.network,
      sourceAddress: raw.sourceAddress,
      destinationAddress: raw.destinationAddress,
      mediatorRequired: raw.usedMediator ?? false,
      // Before the version field an entry was written only for a confirmed merge.
      outcome: "closed",
      completedAt: raw.completedAt,
      memo: null,
      transactions: (raw.txReceipts ?? []).map((r) => ({
        txHash: r.txHash,
        label: r.title,
        stepTypes: [r.type],
        stepTitles: [r.title],
      })),
      groups: null,
      feeLumens: raw.totalFeeLumens ?? null,
      receivedLumens: null,
    };
  }
  const current = raw as Partial<ReceiptRecord> & ReceiptRecord;
  return {
    ...current,
    version: RECORD_VERSION,
    memo: current.memo ?? null,
    transactions: current.transactions ?? [],
    groups: current.groups ?? null,
    feeLumens: current.feeLumens ?? null,
    receivedLumens: current.receivedLumens ?? null,
  };
}

export async function saveHistory(record: ReceiptRecord): Promise<void> {
  const db = await getDb();
  await db.put(HISTORY_STORE_NAME, { ...record, version: RECORD_VERSION });
}

/** The receipt saved under this id in this browser, or null when there is none. */
export async function getHistory(id: string): Promise<ReceiptRecord | null> {
  const db = await getDb();
  const raw = (await db.get(HISTORY_STORE_NAME, id)) as StoredEntry | undefined;
  return raw ? normaliseHistory(raw) : null;
}

export async function listHistory(): Promise<ReceiptRecord[]> {
  const db = await getDb();
  const raw = (await db.getAll(HISTORY_STORE_NAME)) as StoredEntry[];
  return raw
    .map(normaliseHistory)
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
}

/** Fills in what is learned about a saved receipt after it was written, read and written in one
 *  transaction. False when the receipt is gone: it is never recreated here. */
export async function updateHistory(
  id: string,
  patch: Pick<ReceiptRecord, "receivedLumens">
): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
  const raw = (await tx.store.get(id)) as StoredEntry | undefined;
  if (!raw) {
    await tx.done;
    return false;
  }
  await tx.store.put({ ...normaliseHistory(raw), receivedLumens: patch.receivedLumens });
  await tx.done;
  return true;
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(HISTORY_STORE_NAME, id);
}
