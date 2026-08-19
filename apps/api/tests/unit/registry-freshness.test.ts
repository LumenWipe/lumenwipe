import { test, expect } from "bun:test";
import { isRegistryFresh, servedRegistry } from "@/lib/exchange-registry";

// The API states an expiry in what it serves and tells clients they MUST honour it. A rule the
// server declares and does not itself apply protects only the first-party web app -
// /close/transactions is an API-key surface with an SDK behind it.

test("the served payload carries the freshness a consumer can judge it by", () => {
  const served = servedRegistry();
  expect(served.entries.length).toBeGreaterThan(0);
  expect(served.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(served.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("the shipped registry is currently fresh", () => {
  // Fails the build once the file passes its own expiry, which is the point: expiry should be
  // caught here rather than by a user whose exchange close is refused.
  expect(isRegistryFresh()).toBe(true);
});

test("freshness is judged against validUntil, inclusive of that day", () => {
  const until = servedRegistry().validUntil;
  expect(isRegistryFresh(new Date(`${until}T12:00:00Z`))).toBe(true);
  const dayAfter = new Date(Date.parse(`${until}T23:59:59Z`) + 1000);
  expect(isRegistryFresh(dayAfter)).toBe(false);
});
