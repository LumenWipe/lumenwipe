import { FieldValue, Firestore, Timestamp } from "@google-cloud/firestore";
import type { MergeRecord, Network } from "@lumenwipe/types";

export interface Totals {
  accountsClosed: number;
  xlmStroops: string;
}

export interface DayCount {
  date: string;
  accountsClosed: number;
}

/**
 * The public close counter. `record` is the only write and is idempotent per transaction hash:
 * the dedupe check and every counter update commit together or not at all.
 */
export interface MergeStatsStore {
  /** False when the hash was already counted; nothing changes in that case. */
  record(merge: MergeRecord): Promise<boolean>;
  totals(network: Network): Promise<Totals>;
  /** Newest first. */
  recent(network: Network, limit: number): Promise<MergeRecord[]>;
  /** Only days with at least one close, from `fromDate` (inclusive) onward. */
  daily(network: Network, fromDate: string): Promise<DayCount[]>;
}

export const MERGE_STATS_STORE = Symbol("MERGE_STATS_STORE");

/** Daily buckets outlive the 365-day chart by about a month, then a TTL policy deletes them. */
export const DAILY_RETENTION_DAYS = 400;

export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Layout, one tree per network so testnet traffic never touches mainnet's documents:
 *
 *   stats/{network}                      { accountsClosed, xlmStroops, updatedAt }
 *   stats/{network}/merges/{txHash}      { network, accountsClosed, xlmStroops, timestamp }
 *   stats/{network}/mergeDaily/{date}    { date, accountsClosed, expireAt }
 *
 * `xlmStroops` is a decimal string summed with BigInt inside the transaction, because
 * `FieldValue.increment` only takes a JS number and the running total can pass 2^53 stroops.
 */
export class FirestoreMergeStatsStore implements MergeStatsStore {
  private readonly root: FirebaseFirestore.CollectionReference;

  constructor(
    private readonly firestore: Firestore,
    rootCollection = "stats"
  ) {
    this.root = firestore.collection(rootCollection);
  }

  async record(merge: MergeRecord): Promise<boolean> {
    const totalsRef = this.root.doc(merge.network);
    const mergeRef = totalsRef.collection("merges").doc(merge.txHash);
    const closedAt = new Date(merge.timestamp);
    const date = utcDate(closedAt);
    const dailyRef = totalsRef.collection("mergeDaily").doc(date);

    return this.firestore.runTransaction(async (tx) => {
      const [existing, totals] = await tx.getAll(mergeRef, totalsRef);
      if (existing.exists) return false;

      const previous = BigInt((totals.get("xlmStroops") as string | undefined) ?? "0");
      tx.create(mergeRef, {
        network: merge.network,
        accountsClosed: merge.accountsClosed,
        xlmStroops: merge.xlmStroops,
        timestamp: Timestamp.fromDate(closedAt),
      });
      tx.set(
        totalsRef,
        {
          accountsClosed: FieldValue.increment(merge.accountsClosed),
          xlmStroops: (previous + BigInt(merge.xlmStroops)).toString(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(
        dailyRef,
        {
          date,
          accountsClosed: FieldValue.increment(merge.accountsClosed),
          expireAt: Timestamp.fromMillis(Date.parse(date) + DAILY_RETENTION_DAYS * 86_400_000),
        },
        { merge: true }
      );
      return true;
    });
  }

  async totals(network: Network): Promise<Totals> {
    const snap = await this.root.doc(network).get();
    return {
      accountsClosed: (snap.get("accountsClosed") as number | undefined) ?? 0,
      xlmStroops: (snap.get("xlmStroops") as string | undefined) ?? "0",
    };
  }

  async recent(network: Network, limit: number): Promise<MergeRecord[]> {
    const snap = await this.root
      .doc(network)
      .collection("merges")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({
      txHash: d.id,
      network,
      accountsClosed: d.get("accountsClosed") as number,
      xlmStroops: d.get("xlmStroops") as string,
      timestamp: (d.get("timestamp") as Timestamp).toDate().toISOString(),
    }));
  }

  async daily(network: Network, fromDate: string): Promise<DayCount[]> {
    const snap = await this.root
      .doc(network)
      .collection("mergeDaily")
      .where("date", ">=", fromDate)
      .get();
    return snap.docs.map((d) => ({
      date: d.get("date") as string,
      accountsClosed: d.get("accountsClosed") as number,
    }));
  }
}

/** In-process store for dev, tests and CI - none of which set `FIRESTORE_PROJECT_ID`. */
export class InMemoryMergeStatsStore implements MergeStatsStore {
  private readonly merges = new Map<string, MergeRecord>();

  async record(merge: MergeRecord): Promise<boolean> {
    const key = `${merge.network}:${merge.txHash}`;
    if (this.merges.has(key)) return false;
    this.merges.set(key, { ...merge });
    return true;
  }

  async totals(network: Network): Promise<Totals> {
    let accountsClosed = 0;
    let stroops = 0n;
    for (const m of this.byNetwork(network)) {
      accountsClosed += m.accountsClosed;
      stroops += BigInt(m.xlmStroops);
    }
    return { accountsClosed, xlmStroops: stroops.toString() };
  }

  async recent(network: Network, limit: number): Promise<MergeRecord[]> {
    return this.byNetwork(network)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  async daily(network: Network, fromDate: string): Promise<DayCount[]> {
    const days = new Map<string, number>();
    for (const m of this.byNetwork(network)) {
      const date = m.timestamp.slice(0, 10);
      if (date >= fromDate) days.set(date, (days.get(date) ?? 0) + m.accountsClosed);
    }
    return [...days].map(([date, accountsClosed]) => ({ date, accountsClosed }));
  }

  private byNetwork(network: Network): MergeRecord[] {
    return [...this.merges.values()].filter((m) => m.network === network);
  }
}

/** Same gate as `createApiKeyStore`: no Firestore client exists unless the project is set. */
export function createMergeStatsStore(): MergeStatsStore {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) return new InMemoryMergeStatsStore();
  return new FirestoreMergeStatsStore(new Firestore({ projectId }));
}
