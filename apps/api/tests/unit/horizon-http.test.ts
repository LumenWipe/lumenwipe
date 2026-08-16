import { test, expect, beforeEach } from "bun:test";
import {
  horizonGet,
  horizonPaginate,
  rateLimitHits,
  resetRateLimitHits,
  TruncatedCollectionError,
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
  expect(await horizonGet<{ ok: boolean }>("/accounts/G1", { baseUrl: BASE, fetch })).toEqual({
    ok: true,
  });
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
  const all = await horizonPaginate<{ n: number }>(
    "/offers",
    { baseUrl: BASE, fetch },
    PAGE_LIMIT,
    100
  );
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
  const all = await horizonPaginate<{ n: number }>(
    "/offers",
    { baseUrl: BASE, fetch },
    PAGE_LIMIT,
    100
  );
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
  const all = await horizonPaginate<{ n: number }>(
    "/offers",
    { baseUrl: BASE, fetch },
    PAGE_LIMIT,
    100
  );
  expect(all).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

test("refuses a collection that exceeds the cap rather than returning a subset", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }, { n: 2 }] },
      _links: { next: { href: `${BASE}/offers?cursor=x` } },
    })
  );
  // Returning what it got would hand back a subset that reads like the whole set. For
  // claimable balances the sub-entry reconciliation cannot catch that, so it is a silent,
  // permanent loss at merge time - the read has to fail instead.
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 5)
  ).rejects.toThrow(/more than a close can enumerate/);
});

// A `next` pointing anywhere but the configured provider is a fault, not something to
// silently rewrite: pages 2+ of a collection coming from somewhere else means forged or
// omitted records, and claimable balances have no reconciliation to catch it.
test("refuses a pagination link pointing at a different host", async () => {
  const { fetch } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [{ n: 3 }] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: "https://evil.example/offers?cursor=2" } },
        })
  );
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100)
  ).rejects.toThrow(/not the configured provider/);
});

// The case a string-prefix check waves through: "https://horizon.example.attacker.com"
// startsWith "https://horizon.example". Origins are compared, not prefixes.
test("refuses a pagination link on a host that merely prefixes the provider", async () => {
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }, { n: 2 }] },
      _links: { next: { href: "https://horizon.example.attacker.com/offers?cursor=2" } },
    })
  );
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100)
  ).rejects.toThrow(/not the configured provider/);
  expect(calls.every((c) => c.startsWith(`${BASE}/`))).toBe(true);
});

test("follows a relative pagination link on the configured provider", async () => {
  const { fetch, calls } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [{ n: 3 }] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: "/offers?cursor=2" } },
        })
  );
  const all = await horizonPaginate<{ n: number }>(
    "/offers",
    { baseUrl: BASE, fetch },
    PAGE_LIMIT,
    100
  );
  expect(all.map((r) => r.n)).toEqual([1, 2, 3]);
  expect(calls.every((c) => c.startsWith(`${BASE}/`))).toBe(true);
});

// A 404 mid-collection used to read as "end of collection" and return a short list.
test("refuses a 404 on a collection page instead of treating it as the end", async () => {
  const { fetch } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? new Response("", { status: 404 })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: `${BASE}/offers?cursor=2` } },
        })
  );
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, PAGE_LIMIT, 100)
  ).rejects.toThrow(/not an empty result/);
});

test("a trailing slash on the configured base does not produce a double slash", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ id: "abc" }));
  await horizonGet("/accounts/G1", { baseUrl: `${BASE}/`, fetch });
  expect(calls).toEqual([`${BASE}/accounts/G1`]);
});

test("retries a 5xx and succeeds once the provider recovers", async () => {
  let n = 0;
  const { fetch, calls } = recordingFetch(() => {
    n++;
    return n === 1 ? new Response("", { status: 503 }) : jsonResponse({ ok: true });
  });
  expect(await horizonGet<{ ok: boolean }>("/accounts/G1", { baseUrl: BASE, fetch })).toEqual({
    ok: true,
  });
  expect(calls).toHaveLength(2);
});

test("retries a network failure rather than failing the whole read on one bad packet", async () => {
  let n = 0;
  const { fetch, calls } = recordingFetch(() => {
    n++;
    if (n === 1) throw new Error("ECONNRESET");
    return jsonResponse({ ok: true });
  });
  expect(await horizonGet<{ ok: boolean }>("/accounts/G1", { baseUrl: BASE, fetch })).toEqual({
    ok: true,
  });
  expect(calls).toHaveLength(2);
});

test("honors Retry-After and caps it so a hostile value cannot park a close", async () => {
  const started = Date.now();
  let n = 0;
  const { fetch } = recordingFetch(() => {
    n++;
    return n === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
      : jsonResponse({ ok: true });
  });
  await horizonGet("/accounts/G1", { baseUrl: BASE, fetch });
  // 600s honored literally would be ten minutes; the cap is 5s. Asserting both ends so a
  // regression that ignored the header entirely (falling back to a 400ms backoff) also fails.
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThan(4_000);
  expect(elapsed).toBeLessThan(7_000);
}, 15_000);

// Horizon advertises `next` on every full page, including the last one. Checking the cap
// before knowing whether another page exists rejected a *complete* collection of exactly
// maxTotal as truncated - so an account with exactly 1000 offers could not be read at all.
test("accepts a complete collection of exactly maxTotal records", async () => {
  let page = 0;
  const { fetch } = recordingFetch(() => {
    page++;
    // Two full pages, then the empty page Horizon serves past the end - `next` is advertised
    // on the last full page too, so an empty follow-up is the only end-of-collection signal.
    if (page > 2) return jsonResponse({ _embedded: { records: [] } });
    return jsonResponse({
      _embedded: { records: [{ n: page * 2 - 1 }, { n: page * 2 }] },
      _links: { next: { href: `${BASE}/offers?cursor=${page}` } },
    });
  });
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, 2, 4);
  expect(all).toHaveLength(4);
});

test("an over-cap collection is a typed error the caller can tell from a provider fault", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }, { n: 2 }] },
      _links: { next: { href: `${BASE}/offers?cursor=x` } },
    })
  );
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, 2, 4)
  ).rejects.toBeInstanceOf(TruncatedCollectionError);
});

// Commercial providers serve Horizon under a path prefix. Returning the absolute pathname
// duplicated that prefix from page two onward, so pagination 404'd against exactly the
// providers this seam exists to support.
test("follows pagination on a provider served under a path prefix", async () => {
  const base = "https://prov.example/horizon/v1";
  const { fetch, calls } = recordingFetch((url) =>
    url.includes("cursor=2")
      ? jsonResponse({ _embedded: { records: [{ n: 3 }] } })
      : jsonResponse({
          _embedded: { records: [{ n: 1 }, { n: 2 }] },
          _links: { next: { href: `${base}/offers?cursor=2` } },
        })
  );
  const all = await horizonPaginate<{ n: number }>("/offers", { baseUrl: base, fetch }, 2, 100);
  expect(all.map((r) => r.n)).toEqual([1, 2, 3]);
  expect(calls).toEqual([`${base}/offers`, `${base}/offers?cursor=2`]);
});

// "//evil.example/..." satisfies startsWith("/") but is an absolute URL on another host.
test("refuses a protocol-relative pagination link", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({
      _embedded: { records: [{ n: 1 }, { n: 2 }] },
      _links: { next: { href: "//evil.example/offers?cursor=2" } },
    })
  );
  await expect(
    horizonPaginate<{ n: number }>("/offers", { baseUrl: BASE, fetch }, 2, 100)
  ).rejects.toThrow(/not the configured provider/);
});
