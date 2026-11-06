import { expect, test } from "bun:test";
import { Address } from "@stellar/stellar-sdk";
import { xlmContractId } from "@/lib/soroswap/conversion-quotes";
import {
  isXBullEnabled,
  quoteTokenToXlmViaXBull,
  quoteTokenToXlmViaXBullOutcome,
  fetchXBullSwapArgs,
} from "@/lib/xbull/conversion-quotes";

const TOKEN = Address.contract(Buffer.alloc(32, 2)).toString();
const XLM = xlmContractId("mainnet");

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch | null) => ({
  fetch: fetchImpl,
  baseUrl: "https://swap-api.xbull.io",
  now: () => 1_700_000_000_000,
});

test("a 200 quote becomes a conversion with our own floor under it, never the API's own fee-adjusted figure", async () => {
  const fetchImpl = fakeFetch(200, {
    route: "route-1",
    fromAmount: "100000000",
    toAmount: "20045626",
    fromAsset: TOKEN,
    toAsset: XLM,
    fee: { platformFee: "6013", referralsFee: "0" },
  });
  const quote = await quoteTokenToXlmViaXBull(TOKEN, 100_000_000n, "mainnet", deps(fetchImpl));
  expect(quote).toMatchObject({
    token: TOKEN,
    amountIn: "100000000",
    amountOut: "20045626",
    route: ["xbull"],
  });
  expect(BigInt(quote!.minAmountOut)).toBeLessThan(20_045_626n);
});

test("testnet never calls the API and is always null", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  expect(await quoteTokenToXlmViaXBull(TOKEN, 1n, "testnet", deps(fetchImpl))).toBeNull();
  expect(called).toBe(false);
});

test("a non-200, a network error, zero amount, the XLM asset itself, or a mismatched answer all read as not convertible", async () => {
  expect(
    await quoteTokenToXlmViaXBull(TOKEN, 1n, "mainnet", deps(fakeFetch(400, { message: ["x"] })))
  ).toBeNull();
  const throwing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect(await quoteTokenToXlmViaXBull(TOKEN, 1n, "mainnet", deps(throwing))).toBeNull();
  expect(await quoteTokenToXlmViaXBull(TOKEN, 0n, "mainnet", deps(fakeFetch(200, {})))).toBeNull();
  expect(await quoteTokenToXlmViaXBull(XLM, 5n, "mainnet", deps(fakeFetch(200, {})))).toBeNull();
  expect(
    await quoteTokenToXlmViaXBull(
      TOKEN,
      100n,
      "mainnet",
      deps(
        fakeFetch(200, {
          route: "r",
          fromAmount: "99",
          toAmount: "5",
          fromAsset: TOKEN,
          toAsset: XLM,
          fee: { platformFee: "0", referralsFee: "0" },
        })
      )
    )
  ).toBeNull();
});

test("disabled unless the flag is on", () => {
  expect(isXBullEnabled({ enabled: false })).toBe(false);
  expect(isXBullEnabled({ enabled: true })).toBe(true);
});

test("a null deps.fetch (the flag off) is always null, on any network, without ever being called", async () => {
  expect(await quoteTokenToXlmViaXBull(TOKEN, 1n, "mainnet", deps(null))).toBeNull();
});

test("fetchXBullSwapArgs returns the contractArgsXDR the API names, null on any non-200 or malformed body", async () => {
  const ok = fakeFetch(200, { contractArgsXDR: "AAAA", fromAmount: "10", toAmount: "2" });
  expect(
    await fetchXBullSwapArgs(
      "route-1",
      "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK",
      10n,
      1n,
      deps(ok)
    )
  ).toBe("AAAA");
  expect(
    await fetchXBullSwapArgs(
      "route-1",
      "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK",
      10n,
      1n,
      deps(fakeFetch(400, { message: ["Not enough funds"] }))
    )
  ).toBeNull();
});

const body = (over: Record<string, unknown> = {}) => ({
  route: "route-1",
  fromAmount: "100000000",
  toAmount: "20045626",
  fromAsset: TOKEN,
  toAsset: XLM,
  fee: { platformFee: "6013", referralsFee: "0" },
  ...over,
});

const outcome = (status: number, payload: unknown) =>
  quoteTokenToXlmViaXBullOutcome(TOKEN, 100_000_000n, "mainnet", deps(fakeFetch(status, payload)));

test("xBull's own no-route answer (200, empty route, toAmount 0, as observed live) is no_route", async () => {
  expect((await outcome(200, body({ route: "", toAmount: "0" }))).kind).toBe("no_route");
});

test("an xBull 429 is rate_limited; any other failure is unavailable, never no route", async () => {
  expect((await outcome(429, {})).kind).toBe("rate_limited");
  expect((await outcome(500, {})).kind).toBe("unavailable");
  expect((await outcome(200, body({ toAmount: "abc" }))).kind).toBe("unavailable");
  expect((await outcome(200, body({ fromAmount: "1" }))).kind).toBe("unavailable");
  expect((await outcome(200, body({ toAsset: TOKEN }))).kind).toBe("unavailable");
  const throwing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect((await quoteTokenToXlmViaXBullOutcome(TOKEN, 1n, "mainnet", deps(throwing))).kind).toBe(
    "unavailable"
  );
});

test("xBull off, or on testnet, is disabled rather than an answer", async () => {
  expect((await quoteTokenToXlmViaXBullOutcome(TOKEN, 1n, "mainnet", deps(null))).kind).toBe(
    "disabled"
  );
  expect(
    (await quoteTokenToXlmViaXBullOutcome(TOKEN, 1n, "testnet", deps(fakeFetch(200, body())))).kind
  ).toBe("disabled");
});

test("the build round's null wrapper answers exactly what the xBull outcome holds", async () => {
  for (const [status, payload] of [
    [200, body()],
    [200, body({ toAmount: "0" })],
    [429, {}],
    [500, {}],
  ] as const) {
    const o = await outcome(status, payload);
    const wrapped = await quoteTokenToXlmViaXBull(
      TOKEN,
      100_000_000n,
      "mainnet",
      deps(fakeFetch(status, payload))
    );
    expect(wrapped).toEqual(o.kind === "quote" ? o.quote : null);
  }
});
