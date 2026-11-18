import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { FieldPath, Timestamp, type Firestore } from "@google-cloud/firestore";
import { FIRESTORE_BATCH_LIMIT } from "@/auth/api-key-store";
import { backfillExpireAt, main } from "../../scripts/backfill-expire-at";

type Fields = Record<string, unknown>;

/**
 * Documents keyed by full path, with no parent documents: like `usage/{owner}`, a parent exists
 * only as the path of its subcollection, which `listDocuments` still returns. Writes go through
 * `batch().update` only, so a script that replaced a whole document would fail here.
 */
function fakeFirestore(docs: Record<string, Fields>) {
  const store = new Map(Object.entries(docs).map(([path, f]) => [path, { ...f }]));
  const commits: number[] = [];

  const snap = (path: string) => ({
    id: path.split("/").pop()!,
    ref: { path },
    get: (field: string) => store.get(path)![field],
  });

  const query = (prefix: string, limit = Infinity, after = "") => ({
    orderBy: (field: unknown) => {
      expect(field).toEqual(FieldPath.documentId());
      return query(prefix, limit, after);
    },
    limit: (n: number) => query(prefix, n, after),
    startAfter: (s: { ref: { path: string } }) => query(prefix, limit, s.ref.path),
    get: async () => {
      const docs = [...store.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .sort()
        .filter((p) => p > after)
        .slice(0, limit)
        .map(snap);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const firestore = {
    collection: (root: string) => ({
      listDocuments: async () => {
        const ids = [...store.keys()]
          .filter((p) => p.startsWith(`${root}/`))
          .map((p) => p.split("/")[1]!);
        return [...new Set(ids)].map((id) => ({
          collection: (sub: string) => query(`${root}/${id}/${sub}/`),
        }));
      },
    }),
    batch: () => {
      const updates: Array<[string, Fields]> = [];
      return {
        update: (ref: { path: string }, data: Fields) => updates.push([ref.path, data]),
        commit: async () => {
          expect(updates.length).toBeLessThanOrEqual(FIRESTORE_BATCH_LIMIT);
          for (const [path, data] of updates) Object.assign(store.get(path)!, data);
          commits.push(updates.length);
        },
      };
    },
  } as unknown as Firestore;
  return { firestore, store, commits };
}

const at = (iso: string) => Timestamp.fromDate(new Date(iso));
const iso = (value: unknown) => (value as Timestamp).toDate().toISOString();

const close = (timestamp: string) => ({
  network: "mainnet",
  accountsClosed: 1,
  xlmStroops: "10000000",
  timestamp: at(timestamp),
});

describe("backfill-expire-at", () => {
  afterEach(() => mock.restore());

  test("dry run counts what it would write and writes nothing", async () => {
    const { firestore, store, commits } = fakeFirestore({
      "stats/mainnet/merges/a": close("2026-10-08T10:15:00.000Z"),
      "usage/GOWNER/daily/2026-10-09": { owner: "GOWNER", date: "2026-10-09", total: 3 },
    });
    const report = await backfillExpireAt(firestore, false);
    expect(report.merges).toEqual({ scanned: 1, updated: 1, current: 0, bad: [] });
    expect(report.daily).toEqual({ scanned: 1, updated: 1, current: 0, bad: [] });
    expect(commits).toEqual([]);
    expect(store.get("stats/mainnet/merges/a")!.expireAt).toBeUndefined();
  });

  test("sets only expireAt from each record's own time, and a rerun writes nothing", async () => {
    const { firestore, store, commits } = fakeFirestore({
      "stats/mainnet/merges/a": close("2026-10-08T10:15:00.000Z"),
      "stats/testnet/merges/b": close("2026-01-01T00:00:00.000Z"),
      "usage/GOWNER/daily/2026-10-09": { owner: "GOWNER", date: "2026-10-09", total: 3 },
      "usage/ops%2Flabel/daily/2026-10-10": { owner: "ops/label", date: "2026-10-10", total: 1 },
    });
    const first = await backfillExpireAt(firestore, true);
    expect(first.merges.updated + first.daily.updated).toBe(4);

    expect(store.get("stats/mainnet/merges/a")).toEqual({
      ...close("2026-10-08T10:15:00.000Z"),
      expireAt: at("2027-11-12T10:15:00.000Z"),
    });
    expect(iso(store.get("stats/testnet/merges/b")!.expireAt)).toBe("2027-02-05T00:00:00.000Z");
    expect(store.get("usage/GOWNER/daily/2026-10-09")).toEqual({
      owner: "GOWNER",
      date: "2026-10-09",
      total: 3,
      expireAt: at("2027-11-13T00:00:00.000Z"),
    });
    expect(iso(store.get("usage/ops%2Flabel/daily/2026-10-10")!.expireAt)).toBe(
      "2027-11-14T00:00:00.000Z"
    );

    commits.length = 0;
    const second = await backfillExpireAt(firestore, true);
    expect(second.merges).toEqual({ scanned: 2, updated: 0, current: 2, bad: [] });
    expect(second.daily).toEqual({ scanned: 2, updated: 0, current: 2, bad: [] });
    expect(commits).toEqual([]);
  });

  test("corrects a wrong expireAt and leaves the totals and daily buckets alone", async () => {
    const { firestore, store } = fakeFirestore({
      "stats/mainnet/merges/a": {
        ...close("2026-10-08T10:15:00.000Z"),
        expireAt: at("2030-01-01T00:00:00Z"),
      },
      "stats/mainnet/mergeDaily/2026-10-08": { date: "2026-10-08", accountsClosed: 1 },
    });
    const report = await backfillExpireAt(firestore, true);
    expect(report.merges.updated).toBe(1);
    expect(iso(store.get("stats/mainnet/merges/a")!.expireAt)).toBe("2027-11-12T10:15:00.000Z");
    expect(store.get("stats/mainnet/mergeDaily/2026-10-08")!.expireAt).toBeUndefined();
  });

  test("reports and skips a record whose time cannot be read", async () => {
    const { firestore, store } = fakeFirestore({
      "stats/mainnet/merges/a": { ...close("2026-10-08T10:15:00.000Z"), timestamp: "2026-10-08" },
      "stats/mainnet/merges/b": { network: "mainnet" },
      "usage/GOWNER/daily/x": { owner: "GOWNER", total: 1 },
      "usage/GOWNER/daily/y": { owner: "GOWNER", date: "2026-13-45", total: 1 },
      "usage/GOWNER/daily/z": { owner: "GOWNER", date: "2026-10-09", total: 1 },
    });
    const report = await backfillExpireAt(firestore, true);
    expect(report.merges).toEqual({
      scanned: 2,
      updated: 0,
      current: 0,
      bad: ["stats/mainnet/merges/a", "stats/mainnet/merges/b"],
    });
    expect(report.daily.bad).toEqual(["usage/GOWNER/daily/x", "usage/GOWNER/daily/y"]);
    expect(report.daily.updated).toBe(1);
    expect(store.get("usage/GOWNER/daily/x")!.expireAt).toBeUndefined();
  });

  test("walks every page of a collection in batches Firestore accepts", async () => {
    const docs: Record<string, Fields> = {};
    for (let i = 0; i <= FIRESTORE_BATCH_LIMIT; i++) {
      docs[`stats/mainnet/merges/${String(i).padStart(4, "0")}`] = close("2026-10-08T10:15:00Z");
    }
    const { firestore, commits } = fakeFirestore(docs);
    const report = await backfillExpireAt(firestore, true);
    expect(report.merges.scanned).toBe(FIRESTORE_BATCH_LIMIT + 1);
    expect(commits).toEqual([FIRESTORE_BATCH_LIMIT, 1]);
  });

  test("main refuses an unknown flag and reports a dry run", async () => {
    const { firestore } = fakeFirestore({
      "usage/GOWNER/daily/x": { owner: "GOWNER", total: 1 },
    });
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--aply"], firestore)).toBe(2);
    expect(await main([], undefined, {})).toBe(2);
    expect(error.mock.calls).toEqual([
      ["Usage: backfill-expire-at [--apply]"],
      ["FIRESTORE_PROJECT_ID is not set."],
    ]);

    const lines: unknown[][] = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => lines.push(args));
    spyOn(console, "warn").mockImplementation((...args: unknown[]) => lines.push(args));
    expect(await main([], firestore)).toBe(0);
    expect(lines).toEqual([
      ["%s: %d scanned, %d %s, %d already current, %d skipped", "merges", 0, 0, "to update", 0, 0],
      ["%s: no readable time, skipped", "usage/GOWNER/daily/x"],
      ["%s: %d scanned, %d %s, %d already current, %d skipped", "daily", 1, 0, "to update", 0, 1],
      ["Dry run; pass --apply to write."],
    ]);
  });
});
