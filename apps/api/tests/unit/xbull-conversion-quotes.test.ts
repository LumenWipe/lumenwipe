import { expect, test } from "bun:test";
import { Address } from "@stellar/stellar-sdk";
import { xlmContractId } from "@/lib/soroswap/conversion-quotes";
import { isXBullEnabled, quoteTokenToXlmViaXBull, fetchXBullSwapArgs } from "@/lib/xbull/conversion-quotes";

const TOKEN = Address.contract(Buffer.alloc(32, 2)).toString();
const XLM = xlmContractId("mainnet");

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, now: () => 1_700_000_000_000 });

test("a 200 quote becomes a conversion with our own floor under it, never the API's own fee-adjusted figure", async () => {
  const fetchImpl = fakeFetch(200, {
    route: "route-1",
    fromAmount: "100000000",
    toAmount: "20045626",
    fromAsset: TOKEN,
    toAsset: XLM,
    fee: { platformFee: "6013", referralsFee: "0" },
  });
  const quote = await quoteTokenToXlmViaXBull(
    TOKEN,
    100_000_000n,
    "mainnet",
    deps(fetchImpl)
  );
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
      deps(fakeFetch(200, { route: "r", fromAmount: "99", toAmount: "5", fromAsset: TOKEN, toAsset: XLM, fee: { platformFee: "0", referralsFee: "0" } }))
    )
  ).toBeNull();
});

test("disabled unless the flag is on", () => {
  expect(isXBullEnabled({ enabled: false })).toBe(false);
  expect(isXBullEnabled({ enabled: true })).toBe(true);
});

test("fetchXBullSwapArgs returns the contractArgsXDR the API names, null on any non-200 or malformed body", async () => {
  const ok = fakeFetch(200, { contractArgsXDR: "AAAA", fromAmount: "10", toAmount: "2" });
  expect(
    await fetchXBullSwapArgs("route-1", "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK", 10n, 1n, deps(ok))
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
