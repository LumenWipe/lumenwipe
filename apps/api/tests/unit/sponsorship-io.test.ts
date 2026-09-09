import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import {
  enumerateSponsoredEntries,
  fetchOwnerLiveState,
  fetchOwnerLiveStatesBounded,
} from "@/lib/stellar/sponsorship";

// sponsorship.ts reads its Horizon-compatible base URL from PATH_ROUTING_API_URLS, which
// defaults to "" unless NEXT_PUBLIC_PATH_ROUTING_API_TESTNET is set - this worktree has no
// .env.local, so every function under test would otherwise short-circuit to "incomplete"
// before ever calling fetch. Mock the config module to supply a fake base URL instead.
const FAKE_BASE = "https://fake-horizon.test";
// Patched in place on the real config object (and restored after the file), never with
// mock.module: replacing the whole module for the rest of the `bun test` process is what leaked
// stubs into unrelated files in CI.
const realTestnetBase = PATH_ROUTING_API_URLS.testnet;
beforeAll(() => {
  PATH_ROUTING_API_URLS.testnet = FAKE_BASE;
});
afterAll(() => {
  PATH_ROUTING_API_URLS.testnet = realTestnetBase;
});

const OWNER = "GOWNER00000000000000000000000000000000000000000000000";
const SPONSOR = "GSPONSOR000000000000000000000000000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Routes a mocked fetch call to a canned response by matching the request URL against a
// map of path patterns (substring match, checked in insertion order - first match wins).
// Unmatched URLs throw loudly so a test's routing gap surfaces immediately, not as a
// silent 200 with an empty body that would mask what's actually being exercised.
function routedFetch(routes: Array<[string | RegExp, () => Response]>) {
  return mock(async (url: string) => {
    for (const [pattern, respond] of routes) {
      const matches = typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      if (matches) return respond();
    }
    throw new Error(`sponsorship-io.test.ts: unrouted fetch URL: ${url}`);
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── fetchOwnerLiveState ────────────────────────────────────────────────────────

test("fetchOwnerLiveState › owner account 404s → terminal, not a failure, reserve null", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${OWNER}`, () => new Response(null, { status: 404 })],
  ]) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(false);
  expect(result.reserve).toBeNull();
  expect(result.accountSponsor).toBeNull();
});

test("fetchOwnerLiveState › owner account fetch returns a non-OK, non-404 status → fetchFailed", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${OWNER}`, () => new Response(null, { status: 503 })],
  ]) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

test("fetchOwnerLiveState › a healthy account sweeps trustlines, signers, reserve fields, offers, and data entries", async () => {
  globalThis.fetch = routedFetch([
    [
      `/accounts/${OWNER}/offers`,
      () =>
        jsonResponse({
          _embedded: { records: [{ id: "555", sponsor: SPONSOR }] },
        }),
    ],
    [`/accounts/${OWNER}/data/config`, () => jsonResponse({ sponsor: SPONSOR })],
    [
      `/accounts/${OWNER}`,
      () =>
        jsonResponse({
          sponsor: null,
          subentry_count: 3,
          num_sponsoring: 0,
          num_sponsored: 2,
          balances: [
            {
              asset_type: "native",
              balance: "12.5000000",
              selling_liabilities: "0.2500000",
            },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GISSUER0000000000000000000000000000000000000000000000",
              balance: "100.0000000",
              sponsor: SPONSOR,
            },
          ],
          signers: [
            { key: "GSIGNER0000000000000000000000000000000000000000000000", sponsor: SPONSOR },
          ],
          data: { config: "c29tZS12YWx1ZQ==" },
        }),
    ],
  ]) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(false);
  expect(result.reserve).toEqual({
    balanceLumens: "12.5000000",
    numSubEntries: 3,
    numSponsoring: 0,
    numSponsored: 2,
    sellingLiabilities: "0.2500000",
  });
  expect(
    result.trustlineSponsors["USDC:GISSUER0000000000000000000000000000000000000000000000"]
  ).toBe(SPONSOR);
  expect(result.signerSponsors["GSIGNER0000000000000000000000000000000000000000000000"]).toBe(
    SPONSOR
  );
  // Offers are swept unconditionally now - no candidate needed to trigger the fetch.
  expect(result.offerSponsors["555"]).toBe(SPONSOR);
  // The data-entry key list comes from the account resource's own `data` field, not from
  // a caller-supplied hint - this is the fix for the offer/data sweep gap.
  expect(result.dataSponsors.config).toBe(SPONSOR);
});

test("fetchOwnerLiveState › a data-entry key present in `data` but 404 on the per-key sponsor lookup → null, not a failure", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${OWNER}/data/config`, () => new Response(null, { status: 404 })],
    [
      `/accounts/${OWNER}`,
      () =>
        jsonResponse({
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "5.0000000" }],
          signers: [],
          data: { config: "dmFsdWU=" },
        }),
    ],
  ]) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(false);
  expect(result.dataSponsors.config).toBeNull();
});

test("fetchOwnerLiveState › the offers fetch failing → the whole read is fetchFailed, reserve discarded", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${OWNER}/offers`, () => new Response(null, { status: 500 })],
    [
      `/accounts/${OWNER}`,
      () =>
        jsonResponse({
          subentry_count: 0,
          balances: [{ asset_type: "native", balance: "5.0000000" }],
          signers: [],
        }),
    ],
  ]) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

test("fetchOwnerLiveState › a thrown network error anywhere degrades to fetchFailed, never throws out", async () => {
  globalThis.fetch = mock(() => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

// ─── fetchOwnerLiveStatesBounded ────────────────────────────────────────────────

test("fetchOwnerLiveStatesBounded › every owner across multiple concurrency batches ends up in the result map", async () => {
  const owners = Array.from({ length: 23 }, (_, i) => `GOWNER${i.toString().padStart(50, "0")}`);

  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("/offers")) return jsonResponse({ _embedded: { records: [] } });
    return jsonResponse({
      subentry_count: 0,
      balances: [{ asset_type: "native", balance: "1.0000000" }],
      signers: [],
    });
  }) as unknown as typeof fetch;

  const result = await fetchOwnerLiveStatesBounded(owners, "testnet");

  expect(result.size).toBe(owners.length);
  for (const owner of owners) {
    expect(result.get(owner)?.fetchFailed).toBe(false);
  }
});

// ─── enumerateSponsoredEntries ──────────────────────────────────────────────────

test("enumerateSponsoredEntries › a trusted zero short-circuits without calling fetch at all", async () => {
  const fetcher = mock(async () => jsonResponse({}));
  globalThis.fetch = fetcher as unknown as typeof fetch;

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 0, true);

  expect(result).toEqual({ sponsoredEntries: [], sponsorshipEnumerationIncomplete: false });
  expect(fetcher).not.toHaveBeenCalled();
});

test("enumerateSponsoredEntries › an untrusted zero still does real work and is never reported complete", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${SPONSOR}/operations`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
  ]) as unknown as typeof fetch;

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 0, false);

  expect(result.sponsoredEntries).toEqual([]);
  // numSponsoringKnown is false, so the result can never be reported complete no matter
  // what the (empty) history/claimable-balance scan found.
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("enumerateSponsoredEntries › end to end: a sponsored trustline discovered from history is confirmed live and returned", async () => {
  globalThis.fetch = routedFetch([
    [
      `/accounts/${SPONSOR}/operations`,
      () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                type: "change_trust",
                source_account: OWNER,
                sponsor: SPONSOR,
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GISSUER0000000000000000000000000000000000000000000000",
              },
            ],
          },
        }),
    ],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [
      `/accounts/${OWNER}`,
      () =>
        jsonResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "5.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GISSUER0000000000000000000000000000000000000000000000",
              balance: "10.0000000",
              sponsor: SPONSOR,
            },
          ],
          signers: [],
        }),
    ],
  ]) as unknown as typeof fetch;

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 1, true);

  expect(result.sponsoredEntries).toEqual([
    {
      kind: "trustline",
      owner: OWNER,
      asset: "USDC:GISSUER0000000000000000000000000000000000000000000000",
    },
  ]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("enumerateSponsoredEntries › a malformed/unexpected response degrades to incomplete rather than throwing out", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
  ) as unknown as typeof fetch;

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 1, true);

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});
