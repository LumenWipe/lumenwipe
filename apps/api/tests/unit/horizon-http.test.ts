import { test, expect, beforeEach } from "bun:test";
import {
  horizonGet,
  horizonPaginate,
  rateLimitHits,
  resetRateLimitHits,
} from "@/lib/stellar/horizon-http";

const BASE = "https://horizon.example";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** Records every URL requested, so tests can assert call counts and hosts. */
function recordingFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

beforeEach(() => resetRateLimitHits());

// ─── horizonGet ──────────────────────────────────────────────────────────────

test("returns the parsed body on 200", async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ id: "abc" }));
  expect(await horizonGet<{ id: string }>("/accounts/G1", { baseUrl: BASE, fetch })).toEqual({
    id: "abc",
  });
});

test("returns null on 404 so callers can distinguish 'absent' from 'failed'", async () => {
  const { fetch } = recordingFetch(() => new Response("", { status: 404 }));
  expect(await horizonGet("/accounts/G1", { baseUrl: BASE, fetch })).toBeNull();
});

// A partial read is worse than a failed one: a close plan built from it silently skips entries.
test("throws on a server error instead of degrading to an empty result", async () => {
  const { fetch } = recordingFetch(() => new Response("", { status: 500 }));
  await expect(horizonGet("/accounts/G1", { baseUrl: BASE, fetch })).rejects.toThrow(/500/);
});

test("retries a 429 and succeeds once the provider relents", async () => {
  let n = 0;
  const { fetch, calls } = recordingFetch(() => {
    n++;
    return n === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
      : jsonResponse({ ok: true });
  });
  expect(await horizonGet("/accounts/G1", { baseUrl: BASE, fetch })).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
});

test("gives up on sustained 429 with an error naming the config to change", async () => {
  const { fetch } = recordingFetch(
    () => new Response("", { status: 429, headers: { "Retry-After": "0" } })
  );
  await expect(horizonGet("/accounts/G1", { baseUrl: BASE, fetch })).rejects.toThrow(
    /PATH_ROUTING_API/
  );
});

// The counter is the early warning: the public Horizon allows 3600 req/hour per IP and Cloud
// Run egresses from one address, so a rising count means move providers before users notice.
test("counts every rate-limited request", async () => {
  const { fetch } = recordingFetch(
    () => new Response("", { status: 429, headers: { "Retry-After": "0" } })
  );
  expect(rateLimitHits()).toBe(0);
  await horizonGet("/accounts/G1", { baseUrl: BASE, fetch }).catch(() => {});
  expect(rateLimitHits()).toBe(4); // initial attempt + 3 retries
});

// ─── swapping providers ──────────────────────────────────────────────────────

// The whole "pluggable provider" property: the upstream is a base URL, so pointing at another
// Horizon-compatible host is configuration, not code.
test("every request goes to the configured provider", async () => {
  const other = "https://horizon.other-provider.example";
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: "abc" }));
  await horizonGet("/accounts/G1", { baseUrl: other, fetch });
  expect(calls).toEqual([`${other}/accounts/G1`]);
});

// ─── horizonPaginate ─────────────────────────────────────────────────────────

const PAGE_LIMIT = 2;

test("drains every page of a paginated collection", async () => {
  const { fetch } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [{ n: 3 }] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: `${BASE}/offers?cursor=2` } },
        })
  );
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100);
  expect(all.map((r) => r.n)).toEqual([1, 2, 3]);
});

// The failure a domain-level stub could not express, and the reason `fetch` is the seam:
// the provider advertises more data and then delivers nothing. The read must come back short
// so the caller's sub-entry reconciliation can refuse to build a plan, rather than looping.
test("a next link that yields nothing returns a short result rather than hanging", async () => {
  const { fetch, calls } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: `${BASE}/offers?cursor=2` } },
        })
  );
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100);
  expect(all).toHaveLength(2);
  expect(calls).toHaveLength(2);
});

test("stops at a short page even when next is advertised", async () => {
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }] },
      _links: { next: { href: `${BASE}/offers?cursor=9` } },
    })
  );
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100);
  expect(all).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

test("caps the total so an endlessly paginating provider cannot hang a close", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }, { n: 2 }] },
      _links: { next: { href: `${BASE}/offers?cursor=x` } },
    })
  );
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 5);
  expect(all.length).toBeGreaterThanOrEqual(5);
  expect(all.length).toBeLessThan(10);
});

// A `next` pointing at another host must not redirect pagination away from the provider the
// operator configured.
test("pagination stays on the configured host even if next points elsewhere", async () => {
  const { fetch, calls } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [{ n: 3 }] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: "https://evil.example/offers?cursor=2" } },
        })
  );
  await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100);
  expect(calls.every((c) => c.startsWith(BASE))).toBe(true);
});
