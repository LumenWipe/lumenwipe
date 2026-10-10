import { afterEach, beforeEach, expect, test } from "bun:test";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { fetchConversionPath, routeOrNull } from "@/lib/stellar/path-finding";
import { UpstreamError } from "@/lib/stellar/upstream-client";

const ISSUER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const USDC = `USDC:${ISSUER}`;
const original = PATH_ROUTING_API_URLS.testnet;
const NO_WAIT = { sleep: async (): Promise<void> => {} };

beforeEach(() => {
  PATH_ROUTING_API_URLS.testnet = "https://paths.example";
});
afterEach(() => {
  PATH_ROUTING_API_URLS.testnet = original;
});

const route = (amount: string): Response =>
  new Response(
    JSON.stringify({ _embedded: { records: [{ destination_amount: amount, path: [] }] } }),
    { status: 200 }
  );

function sequence(...responses: Array<Response | Error>) {
  let n = 0;
  const fetch = (async () => {
    const next = responses[Math.min(n++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, count: () => n };
}

test("a provider answering 429 then 200 yields a route", async () => {
  const { fetch, count } = sequence(new Response("", { status: 429 }), route("9.0000000"));
  const result = await fetchConversionPath(USDC, "10", "testnet", "native", {
    fetch,
    client: NO_WAIT,
  });
  expect(result.kind).toBe("route");
  expect(count()).toBe(2);
});

test("a provider answering 503 on every attempt is unavailable, not no route", async () => {
  const { fetch, count } = sequence(new Response("", { status: 503 }));
  const result = await fetchConversionPath(USDC, "10", "testnet", "native", {
    fetch,
    client: NO_WAIT,
  });
  expect(result.kind).toBe("unavailable");
  expect(count()).toBe(4);
});

test.each([
  ["a network fault", new TypeError("fetch failed")],
  ["a 400", new Response("", { status: 400 })],
  ["a 404", new Response("", { status: 404 })],
  ["a body that is not JSON", new Response("<html>", { status: 200 })],
])("%s is unavailable, never none", async (_name, response) => {
  const { fetch } = sequence(response);
  const result = await fetchConversionPath(USDC, "10", "testnet", "native", {
    fetch,
    client: NO_WAIT,
  });
  expect(result.kind).toBe("unavailable");
});

test("an unconfigured provider is unavailable, not no route", async () => {
  PATH_ROUTING_API_URLS.testnet = "";
  expect((await fetchConversionPath(USDC, "10", "testnet")).kind).toBe("unavailable");
});

test("only an answered empty market, or an unroutable input, is none", async () => {
  const empty = sequence(new Response(JSON.stringify({ _embedded: { records: [] } })));
  const opts = { fetch: empty.fetch, client: NO_WAIT };
  expect(await fetchConversionPath(USDC, "10", "testnet", "native", opts)).toEqual({
    kind: "none",
  });
  expect((await fetchConversionPath("native", "10", "testnet")).kind).toBe("none");
  expect((await fetchConversionPath(USDC, "0", "testnet")).kind).toBe("none");
  const dust = sequence(route("0.0000001"));
  expect(
    (await fetchConversionPath(USDC, "10", "testnet", "native", { fetch: dust.fetch })).kind
  ).toBe("none");
});

test("routeOrNull never turns an outage into no route", () => {
  const error = new UpstreamError("unavailable", "paths");
  expect(() => routeOrNull({ kind: "unavailable", error })).toThrow(error);
  expect(routeOrNull({ kind: "none" })).toBeNull();
});
