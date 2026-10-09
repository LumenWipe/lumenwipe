import { FieldValue, Firestore } from "@google-cloud/firestore";

export interface DayUsage {
  date: string;
  total: number;
}

/**
 * Per-integrator request counts, one bucket per owner per UTC day. `increment` is the only
 * write; there is no read-modify-write, so concurrent requests never lose a count.
 */
export interface UsageStore {
  increment(owner: string, route: string, date: string): Promise<void>;
  /** Only days with at least one request, from `fromDate` (inclusive) onward. */
  daily(owner: string, fromDate: string): Promise<DayUsage[]>;
}

export const USAGE_STORE = Symbol("USAGE_STORE");

/**
 * Owners are wallet addresses or operator-chosen labels; the second can hold characters a
 * document id may not (`/`, or a `.`/`__` id Firestore reserves), so they are escaped.
 */
export function ownerDocId(owner: string): string {
  return encodeURIComponent(owner).replace(
    /[._]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Layout:
 *
 *   usage/{owner}/daily/{date}   { owner, date, total, byRoute: { "<METHOD> <path>": n }, updatedAt }
 *
 * Every counter moves through `FieldValue.increment`, which the server applies atomically, so
 * one request is exactly one write. Kept indefinitely: these are the records billing reads.
 */
export class FirestoreUsageStore implements UsageStore {
  private readonly root: FirebaseFirestore.CollectionReference;

  constructor(firestore: Firestore, rootCollection = "usage") {
    this.root = firestore.collection(rootCollection);
  }

  async increment(owner: string, route: string, date: string): Promise<void> {
    await this.days(owner)
      .doc(date)
      .set(
        {
          owner,
          date,
          total: FieldValue.increment(1),
          byRoute: { [route]: FieldValue.increment(1) },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  async daily(owner: string, fromDate: string): Promise<DayUsage[]> {
    const snap = await this.days(owner).where("date", ">=", fromDate).get();
    return snap.docs.map((d) => ({
      date: d.get("date") as string,
      total: d.get("total") as number,
    }));
  }

  private days(owner: string): FirebaseFirestore.CollectionReference {
    return this.root.doc(ownerDocId(owner)).collection("daily");
  }
}

/** In-process store for dev, tests and CI - none of which set `FIRESTORE_PROJECT_ID`. */
export class InMemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, Map<string, number>>();

  async increment(owner: string, _route: string, date: string): Promise<void> {
    const days = this.counts.get(owner) ?? new Map<string, number>();
    days.set(date, (days.get(date) ?? 0) + 1);
    this.counts.set(owner, days);
  }

  async daily(owner: string, fromDate: string): Promise<DayUsage[]> {
    return [...(this.counts.get(owner) ?? [])]
      .filter(([date]) => date >= fromDate)
      .map(([date, total]) => ({ date, total }));
  }
}

/** Same gate as `createApiKeyStore`: no Firestore client exists unless the project is set. */
export function createUsageStore(): UsageStore {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) return new InMemoryUsageStore();
  return new FirestoreUsageStore(new Firestore({ projectId }));
}
