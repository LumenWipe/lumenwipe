import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  activeRegistry,
  bundledRegistry,
  fetchServedRegistry,
  setRegistry,
  type RegistrySnapshot,
} from "@/lib/exchange-registry";

// fetchServedRegistry is what a display-only page reads. It must never change the snapshot the
// verifier checks a close against, whatever the endpoint answers.

const SENTINEL: RegistrySnapshot = {
  entries: [],
  lastVerified: "2026-01-01",
  validUntil: "2026-02-01",
  served: true,
};

const serve =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

const SERVED = {
  lastVerified: "2026-11-01",
  validUntil: bundledRegistry().validUntil,
  entries: [
    {
      address: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
      name: "Binance",
      domain: "binance.com",
      requiresMediator: true,
      requiresMemo: true,
      memoType: "id",
    },
  ],
};

beforeEach(() => setRegistry(SENTINEL));
afterAll(() => setRegistry(bundledRegistry()));

test("a served registry is merged over the bundled floor and returned as served", async () => {
  const snapshot = await fetchServedRegistry(serve(SERVED));
  expect(snapshot?.served).toBe(true);
  expect(snapshot?.lastVerified).toBe("2026-11-01");
  expect(snapshot?.entries.length).toBe(bundledRegistry().entries.length);
  expect(snapshot?.memoTypeDisputes).toEqual([SERVED.entries[0].address]);
});

test("reading the served registry leaves the snapshot a close is verified against untouched", async () => {
  await fetchServedRegistry(serve(SERVED));
  expect(activeRegistry()).toBe(SENTINEL);
});

test("a failing, unreachable or malformed endpoint gives null, not a snapshot", async () => {
  expect(await fetchServedRegistry(serve(SERVED, 502))).toBeNull();
  expect(
    await fetchServedRegistry(async () => {
      throw new TypeError("network down");
    })
  ).toBeNull();
  expect(await fetchServedRegistry(serve({ entries: [] }))).toBeNull();
  expect(activeRegistry()).toBe(SENTINEL);
});
