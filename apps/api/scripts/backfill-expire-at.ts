/**
 * Gives every counted close (`stats/{network}/merges`) and every per-owner usage day
 * (`usage/{owner}/daily`) the `expireAt` the store now writes on create, so the TTL policies on
 * the `merges` and `daily` collection groups also reach documents written before it. Dry run by
 * default; `--apply` writes. Only `expireAt` is touched, and a document that already holds the
 * computed value is skipped, so a second run writes nothing. A document whose time cannot be read
 * is reported and left alone.
 *
 *   FIRESTORE_PROJECT_ID=<project> bun run --filter '@lumenwipe/api' backfill:expire-at [--apply]
 */
import { FieldPath, Timestamp, type Firestore } from "@google-cloud/firestore";
import { FIRESTORE_BATCH_LIMIT } from "@/auth/api-key-store";
import { createFirestore } from "@/config/firestore";
import { usageExpireAt } from "@/metering/usage-store";
import { mergeExpireAt } from "@/stats/merge-stats-store";

type Snapshot = FirebaseFirestore.QueryDocumentSnapshot;

export interface CollectionReport {
  scanned: number;
  /** Written with `--apply`; would be written on a dry run. */
  updated: number;
  current: number;
  bad: string[];
}

export interface BackfillReport {
  merges: CollectionReport;
  daily: CollectionReport;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function closedExpireAt(doc: Snapshot): Timestamp | null {
  const timestamp = doc.get("timestamp") as unknown;
  return timestamp instanceof Timestamp ? mergeExpireAt(timestamp.toDate()) : null;
}

function dayExpireAt(doc: Snapshot): Timestamp | null {
  const date = doc.get("date") as unknown;
  if (typeof date !== "string" || !DATE.test(date) || Number.isNaN(Date.parse(date))) return null;
  return usageExpireAt(date);
}

async function backfill(
  firestore: Firestore,
  root: string,
  sub: string,
  expireAt: (doc: Snapshot) => Timestamp | null,
  apply: boolean
): Promise<CollectionReport> {
  const report: CollectionReport = { scanned: 0, updated: 0, current: 0, bad: [] };
  for (const parent of await firestore.collection(root).listDocuments()) {
    const base = parent
      .collection(sub)
      .orderBy(FieldPath.documentId())
      .limit(FIRESTORE_BATCH_LIMIT);
    let last: Snapshot | undefined;
    for (;;) {
      const page = await (last ? base.startAfter(last) : base).get();
      if (page.empty) break;
      const batch = firestore.batch();
      let writes = 0;
      for (const doc of page.docs) {
        report.scanned++;
        const want = expireAt(doc);
        if (!want) {
          report.bad.push(doc.ref.path);
          continue;
        }
        const have = doc.get("expireAt") as unknown;
        if (have instanceof Timestamp && have.isEqual(want)) {
          report.current++;
          continue;
        }
        report.updated++;
        batch.update(doc.ref, { expireAt: want });
        writes++;
      }
      if (apply && writes > 0) await batch.commit();
      last = page.docs[page.docs.length - 1];
      if (page.size < FIRESTORE_BATCH_LIMIT) break;
    }
  }
  return report;
}

export async function backfillExpireAt(
  firestore: Firestore,
  apply: boolean
): Promise<BackfillReport> {
  return {
    merges: await backfill(firestore, "stats", "merges", closedExpireAt, apply),
    daily: await backfill(firestore, "usage", "daily", dayExpireAt, apply),
  };
}

export async function main(
  args: readonly string[],
  firestore?: Firestore,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length > 0) {
    console.error("Usage: backfill-expire-at [--apply]");
    return 2;
  }
  const projectId = env.FIRESTORE_PROJECT_ID;
  if (!firestore && !projectId) {
    console.error("FIRESTORE_PROJECT_ID is not set.");
    return 2;
  }
  const apply = args.includes("--apply");
  const report = await backfillExpireAt(firestore ?? createFirestore(projectId!, env), apply);
  for (const [name, r] of Object.entries(report)) {
    for (const path of r.bad) console.warn("%s: no readable time, skipped", path);
    console.log(
      "%s: %d scanned, %d %s, %d already current, %d skipped",
      name,
      r.scanned,
      r.updated,
      apply ? "updated" : "to update",
      r.current,
      r.bad.length
    );
  }
  if (!apply) console.log("Dry run; pass --apply to write.");
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
