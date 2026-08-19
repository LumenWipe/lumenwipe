import { test, expect, beforeEach } from "bun:test";
import {
  activeRegistry,
  isRegistryUsable,
  loadServedRegistry,
  lookupExchange,
  setRegistry,
  type RegistrySnapshot,
} from "@/lib/exchange-registry";

// The registry decides whether a destination routes through the mediator and what memo it
// needs. Getting that wrong sends funds to a live address that credits nobody: the transaction
// succeeds, there is no error, and the source account is gone. These pin the behaviour that
// makes stale data refuse rather than proceed.

const ENTRY = {
  address: "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
  name: "Test Exchange",
  domain: "example.com",
  requiresMediator: true,
  requiresMemo: true,
  memoType: "text" as const,
};

function snapshot(over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    entries: [ENTRY],
    lastVerified: "2026-08-01",
    validUntil: "2026-12-01",
    served: true,
    ...over,
  };
}

const NOW = new Date("2026-09-01T12:00:00Z");

beforeEach(() => setRegistry(snapshot()));

test("a fresh registry is usable", () => {
  expect(isRegistryUsable(NOW)).toBe(true);
});

test("a registry past its validUntil is not usable", () => {
  setRegistry(snapshot({ validUntil: "2026-08-31" }));
  expect(isRegistryUsable(NOW)).toBe(false);
});

test("the last day of validity still counts as usable", () => {
  // Compared to end-of-day, so a registry does not expire at midnight UTC on the date it
  // states - "valid until the 1st" reads as including the 1st.
  setRegistry(snapshot({ validUntil: "2026-09-01" }));
  expect(isRegistryUsable(NOW)).toBe(true);
});

test("an unparseable validUntil is treated as unusable, not as unlimited", () => {
  // Fail closed on malformed data too: a date nothing can read must not become a registry that
  // never expires.
  setRegistry(snapshot({ validUntil: "not-a-date" }));
  expect(isRegistryUsable(NOW)).toBe(false);
});

test("lookups read the active snapshot, not the bundled file", () => {
  const other = { ...ENTRY, address: "GDIFFERENT", name: "Other" };
  setRegistry(snapshot({ entries: [other] }));
  expect(lookupExchange("GDIFFERENT")?.name).toBe("Other");
  expect(lookupExchange(ENTRY.address)).toBeNull();
});

// ─── loadServedRegistry ──────────────────────────────────────────────────────

test("a served registry replaces the floor and is marked as served", async () => {
  setRegistry(snapshot({ served: false, lastVerified: "2020-01-01" }));
  const served = {
    entries: [ENTRY],
    lastVerified: "2026-08-19",
    validUntil: "2026-11-17",
  };
  await loadServedRegistry(async () => new Response(JSON.stringify(served), { status: 200 }));
  expect(activeRegistry().lastVerified).toBe("2026-08-19");
  expect(activeRegistry().served).toBe(true);
});

test("an unreachable endpoint leaves the floor in place rather than clearing it", async () => {
  const floor = snapshot({ served: false });
  setRegistry(floor);
  await loadServedRegistry(async () => {
    throw new Error("network down");
  });
  // Still the floor, still marked unserved so the UI can say so - and still governed by its
  // own expiry, which is what decides whether it may be relied on at all.
  expect(activeRegistry().served).toBe(false);
  expect(activeRegistry().entries).toHaveLength(1);
});

test("a non-200 response leaves the floor in place", async () => {
  setRegistry(snapshot({ served: false }));
  await loadServedRegistry(async () => new Response("nope", { status: 502 }));
  expect(activeRegistry().served).toBe(false);
});

test("a payload missing its freshness fields is refused", async () => {
  // The dangerous case: adopting entries with no validUntil would leave nothing to expire, so
  // the fail-closed gate becomes a no-op and stale data is trusted forever.
  setRegistry(snapshot({ served: false, validUntil: "2026-12-01" }));
  await loadServedRegistry(
    async () => new Response(JSON.stringify({ entries: [ENTRY] }), { status: 200 })
  );
  expect(activeRegistry().served).toBe(false);
  expect(activeRegistry().validUntil).toBe("2026-12-01");
});

test("a payload whose entries are not an array is refused", async () => {
  setRegistry(snapshot({ served: false }));
  await loadServedRegistry(
    async () =>
      new Response(
        JSON.stringify({
          entries: "everything",
          lastVerified: "2026-08-19",
          validUntil: "2026-11-17",
        }),
        { status: 200 }
      )
  );
  expect(activeRegistry().served).toBe(false);
});
