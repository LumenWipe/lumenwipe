import { test, expect } from "bun:test";
import { fetchOctoPosPortfolio } from "@/lib/defi-positions/octopos-http";

const BASE = "https://octopos.example";
const ADDRESS = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** Records every request (URL + headers), so tests can assert both call shape and count. */
function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

// ─── unconfigured ────────────────────────────────────────────────────────────

test("an empty baseUrl short-circuits without a network call", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({}));
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: "", fetch });
  expect(result).toEqual({
    ok: false,
    reason: "unconfigured",
    detail: expect.any(String),
  });
  expect(calls).toHaveLength(0);
});

// ─── happy path ──────────────────────────────────────────────────────────────

test("returns the parsed body on 200", async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ address: ADDRESS, positions: [] }));
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  expect(result).toEqual({ ok: true, raw: { address: ADDRESS, positions: [] } });
});

test("sends no x-api-key header when no key is configured", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ positions: [] }));
  await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.has("x-api-key")).toBe(false);
});

test("sends the x-api-key header when a key is configured", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ positions: [] }));
  await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, apiKey: "secret123", fetch });
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.get("x-api-key")).toBe("secret123");
});

// ─── degraded mode: never throws ────────────────────────────────────────────

// OctoPos is an optional enhancement (architecture.md: "an OctoPos outage never blocks a
// classic-only close"), so unlike horizonGet this never rejects - it returns a typed failure
// the caller can log and fall back from.
test("a sustained 5xx becomes an unavailable result rather than a rejection", async () => {
  const { fetch } = recordingFetch(() => new Response("", { status: 503 }));
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  expect(result).toEqual({ ok: false, reason: "unavailable", detail: expect.any(String) });
});

test("retries a 429 and succeeds once the provider relents", async () => {
  let n = 0;
  const { fetch, calls } = recordingFetch(() => {
    n++;
    return n === 1 ? new Response("", { status: 429 }) : jsonResponse({ positions: [] });
  });
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  expect(result).toEqual({ ok: true, raw: { positions: [] } });
  expect(calls).toHaveLength(2);
});

test("a network failure becomes an unavailable result rather than a rejection", async () => {
  const fn = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof globalThis.fetch;
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch: fn });
  expect(result).toEqual({ ok: false, reason: "unavailable", detail: expect.any(String) });
});

test("a non-JSON 200 body becomes an unavailable result rather than a rejection", async () => {
  const { fetch } = recordingFetch(() => new Response("not json", { status: 200 }));
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  expect(result).toEqual({ ok: false, reason: "unavailable", detail: expect.any(String) });
});

test("a 404 becomes an unavailable result rather than a rejection", async () => {
  const { fetch } = recordingFetch(() => new Response("", { status: 404 }));
  const result = await fetchOctoPosPortfolio(ADDRESS, { baseUrl: BASE, fetch });
  expect(result).toEqual({ ok: false, reason: "unavailable", detail: expect.any(String) });
});
