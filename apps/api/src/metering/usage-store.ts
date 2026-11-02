import { FieldValue, Firestore } from "@google-cloud/firestore";
import type { UpstreamDelta } from "@/lib/stellar/upstream-metrics";

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
  /** Adds to the UTC day's per-upstream counters; never read back by the API. */
  addUpstreamCounts(date: string, deltas: readonly UpstreamDelta[]): Promise<void>;
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
 *
 *   upstreamUsage/{date}   { date, counts: { <network>: { <upstream>: { <metric>: n } } }, updatedAt }
 *
 * One document per UTC day, written in batches by `UpstreamMetricsService`, not per request.
 */
export class FirestoreUsageStore implements UsageStore {
  private readonly root: FirebaseFirestore.CollectionReference;
  private readonly upstreamRoot: FirebaseFirestore.CollectionReference;

  constructor(
    firestore: Firestore,
    rootCollection = "usage",
    upstreamCollection = "upstreamUsage"
  ) {
    this.root = firestore.collection(rootCollection);
    this.upstreamRoot = firestore.collection(upstreamCollection);
  }

  async addUpstreamCounts(date: string, deltas: readonly UpstreamDelta[]): Promise<void> {
    const counts: Record<string, Record<string, Record<string, FieldValue>>> = {};
    for (const { network, upstream, metric, count } of deltas) {
      const byUpstream = (counts[network] ??= {});
      (byUpstream[upstream] ??= {})[metric] = FieldValue.increment(count);
    }
    await this.upstreamRoot
      .doc(date)
      .set({ date, counts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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
  readonly upstream = new Map<string, number>();

  async addUpstreamCounts(date: string, deltas: readonly UpstreamDelta[]): Promise<void> {
    for (const { network, upstream, metric, count } of deltas) {
      const key = `${date}/${network}/${upstream}/${metric}`;
      this.upstream.set(key, (this.upstream.get(key) ?? 0) + count);
    }
  }

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
