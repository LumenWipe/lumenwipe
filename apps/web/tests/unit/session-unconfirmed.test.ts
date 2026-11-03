import { afterEach, expect, spyOn, test, mock } from "bun:test";
import { findResumableSession, findUnresolved, readUnresolved } from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import type { SessionRecord } from "@/types/session";

const RECORD = { id: "s", status: "in_progress" } as SessionRecord;

afterEach(() => mock.restore());

function fakeDb(start: SessionRecord | undefined, all: SessionRecord[] = []) {
  const puts: SessionRecord[] = [];
  const get = async (id: string) => all.find((s) => s.id === id) ?? start;
  const put = async (record: SessionRecord) => puts.push(record);
  spyOn(sessionStore, "getDb").mockImplementation((async () => ({
    get: async (_store: string, id: string) => get(id),
    getAll: async () => all,
    put: async (_store: string, record: SessionRecord) => put(record),
    transaction: () => ({ store: { get, put }, done: Promise.resolve() }),
  })) as never);
  return puts;
}

test("a refresh keeps the hash, the covers and the deadline, and nothing else", async () => {
  const puts = fakeDb(RECORD);
  const submission = {
    hash: "a".repeat(64),
    covers: ["MERGE"],
    validUntil: 5,
    coversTargets: ["x"],
    needsSponsoredFee: true,
    signedXdr: "must never be stored",
  } as never;
  await sessionStore.saveUnconfirmed("s", submission);
  expect(puts[0]?.unconfirmed).toEqual({ hash: "a".repeat(64), covers: ["MERGE"], validUntil: 5 });
  expect(JSON.stringify(puts[0])).not.toContain("must never be stored");
});

test("settling removes the record", async () => {
  const puts = fakeDb({ ...RECORD, unconfirmed: { hash: "a", covers: [], validUntil: null } });
  await sessionStore.saveUnconfirmed("s", null);
  expect(puts[0]).not.toHaveProperty("unconfirmed");
});

test("a session that no longer exists is left alone and reported", async () => {
  const puts = fakeDb(undefined);
  expect(await sessionStore.saveUnconfirmed("s", null)).toBe(false);
  expect(puts).toEqual([]);
});

function fakeTxDb(held: boolean) {
  const deleted: string[] = [];
  spyOn(sessionStore, "getDb").mockImplementation((async () => ({
    transaction: () => ({
      store: {
        get: async () => ({ ...RECORD, ...(held && { unconfirmed: { hash: "a" } }) }),
        delete: async (id: string) => deleted.push(id),
      },
      done: Promise.resolve(),
    }),
  })) as never);
  return deleted;
}

test("a session that picked up a hash after it was loaded is not deleted", async () => {
  const deleted = fakeTxDb(true);
  expect(await sessionStore.deleteSettledSession("s")).toBe(false);
  expect(deleted).toEqual([]);
});

test("a settled session is deleted", async () => {
  const deleted = fakeTxDb(false);
  expect(await sessionStore.deleteSettledSession("s")).toBe(true);
  expect(deleted).toEqual(["s"]);
});

const HELD = { hash: "a", covers: [], validUntil: 5 };
const session = (id: string, source: string, updatedAt: string, unconfirmed?: typeof HELD) =>
  ({
    id,
    network: "testnet",
    sourceAddress: source,
    status: "in_progress",
    updatedAt,
    ...(unconfirmed && { unconfirmed }),
  }) as SessionRecord;

test("confirming the review again keeps an unresolved hash on the same session", async () => {
  const puts = fakeDb({ ...RECORD, unconfirmed: HELD });
  await sessionStore.saveSession(RECORD);
  expect(puts[0]?.unconfirmed).toEqual(HELD);
});

test("a confirm reads and writes the session in one readwrite transaction", async () => {
  const modes: string[] = [];
  const puts: SessionRecord[] = [];
  spyOn(sessionStore, "getDb").mockImplementation((async () => ({
    get: async () => {
      throw new Error("read outside the transaction");
    },
    put: async () => {
      throw new Error("write outside the transaction");
    },
    transaction: (_store: string, mode: string) => {
      modes.push(mode);
      return {
        store: {
          get: async () => ({ ...RECORD, unconfirmed: HELD }),
          put: async (record: SessionRecord) => puts.push(record),
        },
        done: Promise.resolve(),
      };
    },
  })) as never);
  await sessionStore.saveSession(RECORD);
  expect(modes).toEqual(["readwrite"]);
  expect(puts[0]?.unconfirmed).toEqual(HELD);
});

test("reading the hold rethrows a failed read, which finding it takes as no hold", async () => {
  spyOn(sessionStore, "getDb").mockImplementation((async () => {
    throw new Error("storage unavailable");
  }) as never);
  await expect(readUnresolved("testnet", "GA")).rejects.toThrow("storage unavailable");
  expect(await findUnresolved("testnet", "GA")).toBeNull();
});

test("recovery finds the unresolved session even when a newer one exists", async () => {
  fakeDb(undefined, [
    session("old", "GA", "2026-01-01T00:00:00Z", HELD),
    session("new", "GA", "2026-06-01T00:00:00Z"),
  ]);
  expect((await findResumableSession("testnet"))?.id).toBe("old");
  expect((await findUnresolved("testnet", "GA"))?.id).toBe("old");
});

test("an unresolved hash holds only its own account and network", async () => {
  fakeDb(undefined, [session("old", "GA", "2026-01-01T00:00:00Z", HELD)]);
  expect(await findUnresolved("testnet", "GB")).toBeNull();
  expect(await findUnresolved("mainnet", "GA")).toBeNull();
});

test("settling clears the hash on every session of the account and no other", async () => {
  const other = session("other", "GB", "2026-01-01T00:00:00Z", HELD);
  const puts = fakeDb(undefined, [session("old", "GA", "2026-01-01T00:00:00Z", HELD), other]);
  await sessionStore.clearUnconfirmedFor("testnet", "GA");
  expect(puts.map((p) => p.id)).toEqual(["old"]);
  expect(puts[0]).not.toHaveProperty("unconfirmed");
});
