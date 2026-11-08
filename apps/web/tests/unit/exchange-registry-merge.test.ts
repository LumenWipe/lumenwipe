/**
 * The pure stricter-only merge both the web's served-registry fetch and the verifier's per-call
 * snapshot run. Every field of an entry is checked for what a served copy can and cannot do to it.
 */
import { describe, expect, test } from "bun:test";
import {
  boundedValidUntil,
  isUsableAt,
  isUsableEntry,
  MAX_EXTENSION_DAYS,
  mergeServedRegistry,
  tightenedOver,
  type RegistryEntry,
} from "@/lib/exchange-registry/merge";

const A = `G${"A".repeat(55)}`;
const B = `G${"B".repeat(55)}`;

function entry(address: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    address,
    name: "Exchange",
    domain: "exchange.example",
    requiresMediator: true,
    requiresMemo: true,
    memoType: "text",
    ...over,
  };
}

const FLOOR = { entries: [entry(A)], validUntil: "2027-01-08" };
const body = (entries: unknown[], validUntil = "2027-01-08", lastVerified = "2026-11-01") => ({
  entries,
  lastVerified,
  validUntil,
});

describe("tightenedOver", () => {
  test("a served entry cannot turn off a requirement the bundle sets", () => {
    const merged = tightenedOver(
      entry(A),
      entry(A, { requiresMemo: false, requiresMediator: false })
    );
    expect(merged.requiresMemo).toBe(true);
    expect(merged.requiresMediator).toBe(true);
  });

  test("a served entry can turn on a requirement the bundle does not set", () => {
    const loose = entry(A, { requiresMemo: false, requiresMediator: false });
    expect(
      tightenedOver(loose, entry(A, { requiresMemo: true, requiresMediator: false })).requiresMemo
    ).toBe(true);
    expect(
      tightenedOver(loose, entry(A, { requiresMemo: false, requiresMediator: true }))
        .requiresMediator
    ).toBe(true);
    const both = tightenedOver(loose, entry(A, { requiresMemo: false, requiresMediator: false }));
    expect(both.requiresMemo).toBe(false);
    expect(both.requiresMediator).toBe(false);
  });

  test("the name and domain are the served ones, the memo type the bundled one", () => {
    const merged = tightenedOver(
      entry(A),
      entry(A, { memoType: "id", name: "Renamed", domain: "renamed.example" })
    );
    expect(merged).toEqual(entry(A, { name: "Renamed", domain: "renamed.example" }));
  });
});

describe("isUsableEntry", () => {
  test("accepts a well-formed entry", () => {
    expect(isUsableEntry(entry(A))).toBe(true);
  });

  for (const [what, value] of [
    ["null", null],
    ["a string", "entry"],
    ["a non-string address", { ...entry(A), address: 5 }],
    ["an address not starting with G", { ...entry(A), address: `C${"A".repeat(55)}` }],
    ["a short address", { ...entry(A), address: `G${"A".repeat(54)}` }],
    ["a non-string name", { ...entry(A), name: null }],
    ["a non-boolean requiresMediator", { ...entry(A), requiresMediator: "true" }],
    ["a non-boolean requiresMemo", { ...entry(A), requiresMemo: 1 }],
    ["an unknown memo type", { ...entry(A), memoType: "return" }],
  ] as const) {
    test(`refuses ${what}`, () => {
      expect(isUsableEntry(value)).toBe(false);
    });
  }

  for (const memoType of ["text", "id", "hash"] as const) {
    test(`accepts the ${memoType} memo type`, () => {
      expect(isUsableEntry(entry(A, { memoType }))).toBe(true);
    });
  }
});

describe("boundedValidUntil", () => {
  test("never moves the date earlier than the bundled one", () => {
    expect(boundedValidUntil("2027-01-08", "2027-01-07")).toBe("2027-01-08");
  });

  test("keeps an equal date", () => {
    expect(boundedValidUntil("2027-01-08", "2027-01-08")).toBe("2027-01-08");
  });

  test("moves it later up to the cap, inclusive", () => {
    expect(MAX_EXTENSION_DAYS).toBe(120);
    expect(boundedValidUntil("2027-01-08", "2027-03-01")).toBe("2027-03-01");
    // 2027-01-08 + 120 days.
    expect(boundedValidUntil("2027-01-08", "2027-05-08")).toBe("2027-05-08");
  });

  test("ignores a date past the cap", () => {
    expect(boundedValidUntil("2027-01-08", "2027-05-09")).toBe("2027-01-08");
  });

  test("ignores an unparseable date", () => {
    expect(boundedValidUntil("2027-01-08", "soon")).toBe("2027-01-08");
  });
});

describe("isUsableAt", () => {
  test("is usable through the last second of the date", () => {
    expect(isUsableAt("2027-01-08", new Date("2027-01-08T23:59:59Z"))).toBe(true);
    expect(isUsableAt("2027-01-08", new Date("2027-01-09T00:00:00Z"))).toBe(false);
  });

  test("an unparseable date is never usable", () => {
    expect(isUsableAt("never", new Date("2000-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("mergeServedRegistry", () => {
  for (const [what, value] of [
    ["null", null],
    ["undefined", undefined],
    ["a number", 5],
    ["a string", "registry"],
    [
      "entries that are not a list",
      { entries: {}, lastVerified: "2026-11-01", validUntil: "2027-01-08" },
    ],
    ["no lastVerified", { entries: [], validUntil: "2027-01-08" }],
    ["a non-string lastVerified", { entries: [], lastVerified: 1, validUntil: "2027-01-08" }],
    ["no validUntil", { entries: [], lastVerified: "2026-11-01" }],
    ["a non-string validUntil", { entries: [], lastVerified: "2026-11-01", validUntil: 20270108 }],
  ] as const) {
    test(`returns null for ${what}`, () => {
      expect(mergeServedRegistry(FLOOR, value)).toBeNull();
    });
  }

  test("keeps every bundled entry when the served list leaves it out", () => {
    expect(mergeServedRegistry(FLOOR, body([]))).toEqual({
      entries: [entry(A)],
      lastVerified: "2026-11-01",
      validUntil: "2027-01-08",
      memoTypeDisputes: [],
    });
  });

  test("tightens, never relaxes, a bundled entry", () => {
    const merged = mergeServedRegistry(
      FLOOR,
      body([entry(A, { requiresMemo: false, requiresMediator: false, memoType: "id" })])
    );
    expect(merged?.entries).toEqual([entry(A)]);
  });

  test("adds an address the bundle does not know, as served", () => {
    const added = entry(B, { requiresMediator: false });
    expect(mergeServedRegistry(FLOOR, body([added]))?.entries).toEqual([entry(A), added]);
  });

  test("drops malformed entries and keeps the rest", () => {
    const added = entry(B);
    expect(mergeServedRegistry(FLOOR, body([null, { address: B }, added]))?.entries).toEqual([
      entry(A),
      added,
    ]);
  });

  test("each duplicate is tightened against the bundled entry, the last one standing", () => {
    const merged = mergeServedRegistry(
      FLOOR,
      body([entry(A, { memoType: "id" }), entry(A, { requiresMemo: false, memoType: "hash" })])
    );
    expect(merged?.entries).toEqual([entry(A)]);
    expect(merged?.memoTypeDisputes).toEqual([A]);
  });

  test("bounds the validity date", () => {
    expect(mergeServedRegistry(FLOOR, body([], "2026-12-01"))?.validUntil).toBe("2027-01-08");
    expect(mergeServedRegistry(FLOOR, body([], "2027-03-01"))?.validUntil).toBe("2027-03-01");
    expect(mergeServedRegistry(FLOOR, body([], "2030-01-01"))?.validUntil).toBe("2027-01-08");
  });

  test("never takes a served memo type for a bundled entry, and records the dispute", () => {
    const merged = mergeServedRegistry(FLOOR, body([entry(A, { memoType: "id" }), entry(B)]));
    expect(merged?.entries).toEqual([entry(A), entry(B)]);
    expect(merged?.memoTypeDisputes).toEqual([A]);
  });

  test("records no dispute when the served type matches the bundled one", () => {
    const merged = mergeServedRegistry(FLOOR, body([entry(A, { requiresMediator: false })]));
    expect(merged?.memoTypeDisputes).toEqual([]);
  });

  test("leaves the floor it was given untouched", () => {
    const floor = { entries: [entry(A)], validUntil: "2027-01-08" };
    mergeServedRegistry(floor, body([entry(A, { requiresMemo: false }), entry(B)]));
    expect(floor).toEqual({ entries: [entry(A)], validUntil: "2027-01-08" });
  });
});
