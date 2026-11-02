import { afterEach, expect, spyOn, test, mock } from "bun:test";
import * as sessionStore from "@/lib/session/store";
import type { SessionRecord } from "@/types/session";

const RECORD = { id: "s", status: "in_progress" } as SessionRecord;

afterEach(() => mock.restore());

function fakeDb(start: SessionRecord | undefined) {
  const puts: SessionRecord[] = [];
  spyOn(sessionStore, "getDb").mockImplementation((async () => ({
    get: async () => start,
    put: async (_store: string, record: SessionRecord) => puts.push(record),
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

test("a session that no longer exists is left alone", async () => {
  const puts = fakeDb(undefined);
  await sessionStore.saveUnconfirmed("s", null);
  expect(puts).toEqual([]);
});
