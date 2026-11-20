import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { poolShareTrustlineKey } from "@/lib/stellar/live-ledger";
import * as rpcModule from "@/lib/stellar/rpc";
import {
  enumerateSponsoredEntries,
  fetchOwnerLiveState,
  fetchOwnerLiveStatesBounded,
} from "@/lib/stellar/sponsorship";
import { fakeFetch } from "../support/fetch";

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
function routedFetch(routes: Array<[string | RegExp, () => Response]>): typeof fetch {
  return fakeFetch(async (url) => {
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
  ]);

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(false);
  expect(result.reserve).toBeNull();
  expect(result.accountSponsor).toBeNull();
});

test("fetchOwnerLiveState › owner account fetch returns a non-OK, non-404 status → fetchFailed", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${OWNER}`, () => new Response(null, { status: 503 })],
  ]);

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
  ]);

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
  ]);

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
  ]);

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

test("fetchOwnerLiveState › a thrown network error anywhere degrades to fetchFailed, never throws out", async () => {
  globalThis.fetch = fakeFetch(
    mock(() => {
      throw new Error("ECONNRESET");
    })
  );

  const result = await fetchOwnerLiveState(OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

// ─── fetchOwnerLiveStatesBounded ────────────────────────────────────────────────

test("fetchOwnerLiveStatesBounded › every owner across multiple concurrency batches ends up in the result map", async () => {
  const owners = Array.from({ length: 23 }, (_, i) => `GOWNER${i.toString().padStart(50, "0")}`);

  globalThis.fetch = fakeFetch(
    mock(async (url: string) => {
      if (url.includes("/offers")) return jsonResponse({ _embedded: { records: [] } });
      return jsonResponse({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "1.0000000" }],
        signers: [],
      });
    })
  );

  const result = await fetchOwnerLiveStatesBounded(owners, "testnet");

  expect(result.size).toBe(owners.length);
  for (const owner of owners) {
    expect(result.get(owner)?.fetchFailed).toBe(false);
  }
});

// ─── enumerateSponsoredEntries ──────────────────────────────────────────────────

test("enumerateSponsoredEntries › a trusted zero short-circuits without calling fetch at all", async () => {
  const fetcher = mock(async () => jsonResponse({}));
  globalThis.fetch = fakeFetch(fetcher);

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 0, true);

  expect(result).toEqual({ sponsoredEntries: [], sponsorshipEnumerationIncomplete: false });
  expect(fetcher).not.toHaveBeenCalled();
});

test("enumerateSponsoredEntries › an untrusted zero still does real work and is never reported complete", async () => {
  globalThis.fetch = routedFetch([
    [`/accounts/${SPONSOR}/operations`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
  ]);

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
  ]);

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
  globalThis.fetch = fakeFetch(
    mock(
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
    )
  );

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 1, true);

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

function failsOnce(respond: () => Response): () => Response {
  let calls = 0;
  return () => (calls++ === 0 ? new Response(null, { status: 503 }) : respond());
}

test("enumerateSponsoredEntries › one transient 5xx per request no longer marks the enumeration incomplete", async () => {
  const issuer = "GISSUER0000000000000000000000000000000000000000000000";
  globalThis.fetch = routedFetch([
    [
      `/accounts/${SPONSOR}/operations`,
      failsOnce(() =>
        jsonResponse({
          _embedded: {
            records: [
              {
                type: "change_trust",
                source_account: OWNER,
                sponsor: SPONSOR,
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: issuer,
              },
            ],
          },
        })
      ),
    ],
    [`/claimable_balances`, failsOnce(() => jsonResponse({ _embedded: { records: [] } }))],
    [`/accounts/${OWNER}/offers`, failsOnce(() => jsonResponse({ _embedded: { records: [] } }))],
    [
      `/accounts/${OWNER}`,
      failsOnce(() =>
        jsonResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "5.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: issuer,
              balance: "10.0000000",
              sponsor: SPONSOR,
            },
          ],
          signers: [],
        })
      ),
    ],
  ]);

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 1, true);

  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
  expect(result.sponsoredEntries).toHaveLength(1);
});

test("enumerateSponsoredEntries › a provider that keeps failing still degrades to incomplete, after retries", async () => {
  const fetchMock = mock(async () => new Response(null, { status: 503 }));
  globalThis.fetch = fakeFetch(fetchMock);

  const result = await enumerateSponsoredEntries(SPONSOR, "testnet", 1, true);

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
  expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
});

test("fetchOwnerLiveStatesBounded › owner fan-out narrows once a 429 has been seen", async () => {
  const owners = Array.from({ length: 14 }, (_, i) => `GOWNER${String(i).padStart(2, "0")}`);
  let rateLimited = false;
  let inflight = 0;
  const laterMax: number[] = [];
  globalThis.fetch = fakeFetch(
    mock(async (url: string) => {
      const index = owners.findIndex((o) => url.includes(`/accounts/${o}`));
      if (index === 0 && !rateLimited) {
        rateLimited = true;
        return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
      }
      inflight++;
      if (index >= 10) laterMax.push(inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
      return url.endsWith("/offers?limit=200")
        ? jsonResponse({ _embedded: { records: [] } })
        : jsonResponse({
            subentry_count: 0,
            balances: [{ asset_type: "native", balance: "5.0000000" }],
            signers: [],
          });
    })
  );

  const result = await fetchOwnerLiveStatesBounded(owners, "testnet");

  expect(result.size).toBe(14);
  expect([...result.values()].every((s) => !s.fetchFailed)).toBe(true);
  expect(Math.max(...laterMax)).toBeLessThanOrEqual(2);
});

// ─── pool share trustlines ──────────────────────────────────────────────────────

const POOL_OWNER = Keypair.random().publicKey();
const POOL_SPONSOR = Keypair.random();
const POOL_ID = "d714bc2e56f74a4a4de2e81284a35b6fe09582f081bf785fc698310895c2d845";

/** A ledger extension naming `sponsor`, as the RPC sends it in `extXdr`. */
function sponsoredExt(sponsor: Keypair): string {
  return xdr.LedgerEntryExt.v1(
    new xdr.LedgerEntryExtensionV1({
      sponsoringId: sponsor.xdrAccountId(),
      ext: xdr.LedgerEntryExtensionV1Ext.v0(),
    })
  ).toXDR("base64");
}

/** Answers the raw ledger read for every key asked with `extXdr`, or fails it when null. */
function rpcAnswering(extXdr: string | null) {
  const asked: string[] = [];
  spyOn(rpcModule, "getRpcServer").mockReturnValue({
    async _getLedgerEntries(...keys: xdr.LedgerKey[]) {
      asked.push(...keys.map((k) => k.toXDR("base64")));
      if (extXdr === null) throw new Error("rpc down");
      return {
        entries: keys.map((k) => ({ key: k.toXDR("base64"), xdr: "AAAAAQ==", extXdr })),
      };
    },
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>);
  return asked;
}

// Horizon's account resource as testnet sends it for a sponsored pool share line: the pool
// balance carries `liquidity_pool_id` and no `sponsor`.
function poolOwnerAccount(poolBalance: Record<string, unknown>) {
  return jsonResponse({
    subentry_count: 1,
    num_sponsored: 2,
    balances: [{ asset_type: "native", balance: "5.0000000" }, poolBalance],
    signers: [],
  });
}

const POOL_BALANCE = {
  asset_type: "liquidity_pool_shares",
  liquidity_pool_id: POOL_ID,
  balance: "0.0000000",
};

afterEach(() => {
  mock.restore();
});

test("fetchOwnerLiveState › a pool share line's sponsor is read from its ledger entry, not Horizon", async () => {
  const asked = rpcAnswering(sponsoredExt(POOL_SPONSOR));
  globalThis.fetch = routedFetch([
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}`, () => poolOwnerAccount(POOL_BALANCE)],
  ]);

  const result = await fetchOwnerLiveState(POOL_OWNER, "testnet");

  expect(result.fetchFailed).toBe(false);
  expect(result.poolShareSponsors).toEqual({ [POOL_ID]: POOL_SPONSOR.publicKey() });
  expect(result.trustlineSponsors).toEqual({ native: null });
  expect(asked).toEqual([poolShareTrustlineKey(POOL_OWNER, POOL_ID).toXDR("base64")]);
});

test("fetchOwnerLiveState › a pool share sponsor that cannot be read fails the owner's read", async () => {
  rpcAnswering(null);
  globalThis.fetch = routedFetch([
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}`, () => poolOwnerAccount(POOL_BALANCE)],
  ]);

  const result = await fetchOwnerLiveState(POOL_OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(result.reserve).toBeNull();
});

test("fetchOwnerLiveState › a pool share balance without a pool id fails the owner's read", async () => {
  const asked = rpcAnswering(sponsoredExt(POOL_SPONSOR));
  globalThis.fetch = routedFetch([
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [
      `/accounts/${POOL_OWNER}`,
      () => poolOwnerAccount({ asset_type: "liquidity_pool_shares", balance: "0.0000000" }),
    ],
  ]);

  const result = await fetchOwnerLiveState(POOL_OWNER, "testnet");

  expect(result.fetchFailed).toBe(true);
  expect(asked).toEqual([]);
});

test("enumerateSponsoredEntries › a sponsored pool share trustline is listed, and the count of 2 reserves completes the enumeration", async () => {
  rpcAnswering(sponsoredExt(POOL_SPONSOR));
  const sponsor = POOL_SPONSOR.publicKey();
  globalThis.fetch = routedFetch([
    [
      `/accounts/${sponsor}/operations`,
      () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                type: "change_trust",
                source_account: POOL_OWNER,
                sponsor,
                asset_type: "liquidity_pool_shares",
                liquidity_pool_id: POOL_ID,
              },
            ],
          },
        }),
    ],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}`, () => poolOwnerAccount(POOL_BALANCE)],
  ]);

  const result = await enumerateSponsoredEntries(sponsor, "testnet", 2, true);

  expect(result.sponsoredEntries).toEqual([
    { kind: "pool_share_trustline", owner: POOL_OWNER, poolId: POOL_ID },
  ]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("enumerateSponsoredEntries › an earlier revoke of a pool share line's sponsorship names its owner", async () => {
  rpcAnswering(sponsoredExt(POOL_SPONSOR));
  const sponsor = POOL_SPONSOR.publicKey();
  globalThis.fetch = routedFetch([
    [
      `/accounts/${sponsor}/operations`,
      () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                type: "revoke_sponsorship",
                source_account: sponsor,
                trustline_account_id: POOL_OWNER,
                trustline_liquidity_pool_id: POOL_ID,
              },
            ],
          },
        }),
    ],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}`, () => poolOwnerAccount(POOL_BALANCE)],
  ]);

  const result = await enumerateSponsoredEntries(sponsor, "testnet", 2, true);

  expect(result.sponsoredEntries).toEqual([
    { kind: "pool_share_trustline", owner: POOL_OWNER, poolId: POOL_ID },
  ]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("enumerateSponsoredEntries › a pool share line sponsored by someone else is not listed, and the reserves stay unexplained", async () => {
  rpcAnswering(sponsoredExt(Keypair.random()));
  const sponsor = POOL_SPONSOR.publicKey();
  globalThis.fetch = routedFetch([
    [
      `/accounts/${sponsor}/operations`,
      () =>
        jsonResponse({
          _embedded: {
            records: [
              {
                type: "change_trust",
                source_account: POOL_OWNER,
                sponsor,
                asset_type: "liquidity_pool_shares",
                liquidity_pool_id: POOL_ID,
              },
            ],
          },
        }),
    ],
    [`/claimable_balances`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}/offers`, () => jsonResponse({ _embedded: { records: [] } })],
    [`/accounts/${POOL_OWNER}`, () => poolOwnerAccount(POOL_BALANCE)],
  ]);

  const result = await enumerateSponsoredEntries(sponsor, "testnet", 2, true);

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});
