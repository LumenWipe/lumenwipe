import { afterEach, beforeEach, expect, test } from "bun:test";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { fetchConversionPath, routeOrNull } from "@/lib/stellar/path-finding";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { EMPTY_MARKET, MAINNET_DUST_SHX, MAINNET_LIQUID_USDC } from "./fixtures/horizon-paths";

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const lookup = (body: Response, amount = "10") =>
  fetchConversionPath(USDC, amount, "testnet", "native", {
    fetch: sequence(body).fetch,
    client: NO_WAIT,
  });

test("only an answered empty market, or an unroutable input, is none", async () => {
  expect(await lookup(json(EMPTY_MARKET))).toEqual({ kind: "none", reason: "no_market" });
  expect((await fetchConversionPath("native", "10", "testnet")).kind).toBe("none");
  expect((await fetchConversionPath(USDC, "0", "testnet")).kind).toBe("none");
});

test("the shape Horizon really returns for a liquid asset is a route", async () => {
  const result = await lookup(json(MAINNET_LIQUID_USDC));
  expect(result).toMatchObject({
    kind: "route",
    path: { estimatedReceive: "49.2658130", destMin: "49.0194839", path: [] },
  });
});

test.each(["0.0000001", "0.0000002"])(
  "a %s balance whose best quote is one stroop is dust, not an empty market",
  async (amount) => {
    expect(await lookup(json(MAINNET_DUST_SHX), amount)).toEqual({
      kind: "none",
      reason: "dust_below_minimum",
    });
  }
);

test.each([
  ["a body without _embedded", {}],
  ["a JSON null body", null],
  ["records that are not an array", { _embedded: { records: {} } }],
  ["records missing", { _embedded: {} }],
  [
    "a record with a non-numeric amount",
    { _embedded: { records: [{ destination_amount: "abc", path: [] }] } },
  ],
  ["a record without a path", { _embedded: { records: [{ destination_amount: "1.0000000" }] } }],
  [
    "a record whose path hop has no issuer",
    {
      _embedded: {
        records: [{ destination_amount: "1.0000000", path: [{ asset_type: "credit_alphanum4" }] }],
      },
    },
  ],
  ["a record that is not an object", { _embedded: { records: ["x"] } }],
])("%s is unavailable and retryable, never no route", async (_name, body) => {
  const result = await lookup(json(body));
  expect(result.kind).toBe("unavailable");
  if (result.kind === "unavailable") expect(result.error.kind).toBe("unavailable");
});

test("a 4xx answer is reported as a retryable outage, not an unusable provider", async () => {
  const result = await lookup(new Response("", { status: 400 }));
  expect(result.kind === "unavailable" && result.error.kind).toBe("unavailable");
});

test("routeOrNull never turns an outage into no route", () => {
  const error = new UpstreamError("unavailable", "paths");
  expect(() => routeOrNull({ kind: "unavailable", error })).toThrow(error);
  expect(routeOrNull({ kind: "none", reason: "no_market" })).toBeNull();
});
