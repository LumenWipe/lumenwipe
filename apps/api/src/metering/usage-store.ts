import { FieldValue, Firestore } from "@google-cloud/firestore";
import { isKeyId } from "@/auth/api-key-store";
import type { UpstreamDelta } from "@/lib/stellar/upstream-metrics";

export interface DayUsage {
  date: string;
  total: number;
  /** Successful requests per key id; absent on a day no self-serve key was used. */
  byKey?: Record<string, number>;
  /** Requests refused with 429 per key id, never part of `total`. */
  rateLimitedByKey?: Record<string, number>;
}

export interface RateLimitedCount {
  owner: string;
  keyId: string;
  date: string;
  count: number;
}

/**
 * Per-integrator request counts, one bucket per owner per UTC day. `increment` is the only
 * write; there is no read-modify-write, so concurrent requests never lose a count.
 */
export interface UsageStore {
  /** `keyId` is counted per key only when it has the key id shape. */
  increment(owner: string, route: string, date: string, keyId?: string | null): Promise<void>;
  /** Adds 429 counts per key, outside `total`; written in batches, not per request. */
  addRateLimited(counts: readonly RateLimitedCount[]): Promise<void>;
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
 *   usage/{owner}/daily/{date}   { owner, date, total, byRoute: { "<METHOD> <path>": n },
 *                                  byKey: { <key id>: n }, rateLimitedByKey: { <key id>: n },
 *                                  updatedAt }
 *
 * Every counter moves through `FieldValue.increment`, which the server applies atomically, so
 * one request is exactly one write: `byKey` rides in the same write as `total`. 429s are counted
 * in memory and added in batches (`KeyActivityService`), and never touch `total`, which is what
 * billing reads. Kept indefinitely. A key id is a SHA-256 hex hash, checked before it becomes a
 * field name.
 *
 *   upstreamUsage/{date}   { date, counts: { <network>: { <upstream>: { <metric>: n } } }, updatedAt }
 *
 * One document per UTC day, written in batches by `UpstreamMetricsService`, not per request.
 */
export class FirestoreUsageStore implements UsageStore {
  private readonly root: FirebaseFirestore.CollectionReference;
  private readonly upstreamRoot: FirebaseFirestore.CollectionReference;

  constructor(
    private readonly firestore: Firestore,
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

  async increment(
    owner: string,
    route: string,
    date: string,
    keyId: string | null = null
  ): Promise<void> {
    await this.days(owner)
      .doc(date)
      .set(
        {
          owner,
          date,
          total: FieldValue.increment(1),
          byRoute: { [route]: FieldValue.increment(1) },
          ...(keyId && isKeyId(keyId) && { byKey: { [keyId]: FieldValue.increment(1) } }),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  async addRateLimited(counts: readonly RateLimitedCount[]): Promise<void> {
    const valid = counts.filter((c) => isKeyId(c.keyId) && c.count > 0);
    if (valid.length === 0) return;
    const batch = this.firestore.batch();
    for (const { owner, keyId, date, count } of valid) {
      batch.set(
        this.days(owner).doc(date),
        {
          owner,
          date,
          rateLimitedByKey: { [keyId]: FieldValue.increment(count) },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }

  async daily(owner: string, fromDate: string): Promise<DayUsage[]> {
    const snap = await this.days(owner).where("date", ">=", fromDate).get();
    return snap.docs.map((d) => ({
      date: d.get("date") as string,
      // A day with only 429s has no `total`.
      total: (d.get("total") as number | undefined) ?? 0,
      byKey: d.get("byKey") as Record<string, number> | undefined,
      rateLimitedByKey: d.get("rateLimitedByKey") as Record<string, number> | undefined,
    }));
  }

  private days(owner: string): FirebaseFirestore.CollectionReference {
    return this.root.doc(ownerDocId(owner)).collection("daily");
  }
}

/** In-process store for dev, tests and CI - none of which set `FIRESTORE_PROJECT_ID`. */
interface MemoryDay {
  total: number;
  byKey: Map<string, number>;
  rateLimitedByKey: Map<string, number>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, Map<string, MemoryDay>>();
  readonly upstream = new Map<string, number>();

  async addUpstreamCounts(date: string, deltas: readonly UpstreamDelta[]): Promise<void> {
    for (const { network, upstream, metric, count } of deltas) {
      const key = `${date}/${network}/${upstream}/${metric}`;
      this.upstream.set(key, (this.upstream.get(key) ?? 0) + count);
    }
  }

  private day(owner: string, date: string): MemoryDay {
    const days = this.counts.get(owner) ?? new Map<string, MemoryDay>();
    this.counts.set(owner, days);
    const day = days.get(date) ?? { total: 0, byKey: new Map(), rateLimitedByKey: new Map() };
    days.set(date, day);
    return day;
  }

  async increment(
    owner: string,
    _route: string,
    date: string,
    keyId: string | null = null
  ): Promise<void> {
    const day = this.day(owner, date);
    day.total++;
    if (keyId && isKeyId(keyId)) day.byKey.set(keyId, (day.byKey.get(keyId) ?? 0) + 1);
  }

  async addRateLimited(counts: readonly RateLimitedCount[]): Promise<void> {
    for (const { owner, keyId, date, count } of counts) {
      if (!isKeyId(keyId) || count <= 0) continue;
      const day = this.day(owner, date);
      day.rateLimitedByKey.set(keyId, (day.rateLimitedByKey.get(keyId) ?? 0) + count);
    }
  }

  async daily(owner: string, fromDate: string): Promise<DayUsage[]> {
    return [...(this.counts.get(owner) ?? [])]
      .filter(([date]) => date >= fromDate)
      .map(([date, day]) => ({
        date,
        total: day.total,
        ...(day.byKey.size > 0 && { byKey: Object.fromEntries(day.byKey) }),
        ...(day.rateLimitedByKey.size > 0 && {
          rateLimitedByKey: Object.fromEntries(day.rateLimitedByKey),
        }),
      }));
  }
}

/** Same gate as `createApiKeyStore`: no Firestore client exists unless the project is set. */
export function createUsageStore(): UsageStore {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) return new InMemoryUsageStore();
  return new FirestoreUsageStore(new Firestore({ projectId }));
}
