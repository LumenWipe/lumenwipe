import { afterEach, expect, test } from "bun:test";
import { inRequestContext } from "../support/request-context";
import { healthAnswer, latestLedger } from "../support/rpc-fixtures";
import { fakeRpcServer } from "../support/rpc-server";
import { fakeFetch } from "../support/fetch";
import { RPC_FALLBACKS, RPC_HEADERS, RPC_URLS } from "@/config/networks";
import { pinRpcProvider, readLatestLedger, resetRpcCooldowns } from "@/lib/stellar/rpc";
import { providerFailoverCount, resetProviderFailoverCount } from "@/lib/stellar/provider-failover";
import { UpstreamError } from "@/lib/stellar/upstream-client";

const unexpected = (): Promise<never> => Promise.reject(new Error("getLatestLedger was called"));

test("a healthy answer is the ledger, with no getLatestLedger call", async () => {
  const server = fakeRpcServer({
    getHealth: () => Promise.resolve(healthAnswer(700, 1_800_000_000)),
    getLatestLedger: unexpected,
  });
  expect(await readLatestLedger(server)).toEqual({ sequence: 700, closeTime: "1800000000" });
});

test("a health answer missing the ledger or a readable close time asks getLatestLedger", async () => {
  const partial: Partial<ReturnType<typeof healthAnswer>>[] = [
    { latestLedgerCloseTime: undefined },
    { latestLedgerCloseTime: "not-a-time" },
    { latestLedgerCloseTime: "0" },
    { latestLedger: undefined },
    { latestLedger: 1.5 },
  ];
  for (const change of partial) {
    let asked = 0;
    const server = fakeRpcServer({
      getHealth: () => Promise.resolve(Object.assign(healthAnswer(700), change)),
      getLatestLedger: () => {
        asked += 1;
        return Promise.resolve(latestLedger(701, 1_800_000_000));
      },
    });
    expect(await readLatestLedger(server)).toEqual({ sequence: 701, closeTime: "1800000000" });
    expect(asked).toBe(1);
  }
});

test("a status other than healthy is a typed unavailable, never a ledger", async () => {
  for (const status of ["unhealthy", undefined]) {
    const server = fakeRpcServer({
      getHealth: () => Promise.resolve(Object.assign(healthAnswer(700), { status })),
      getLatestLedger: unexpected,
    });
    const failure = await readLatestLedger(server).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ kind: "unavailable" });
  }
});

test("a failed health read is the caller's failure, not a getLatestLedger fallback", async () => {
  const down = new UpstreamError("rate_limited", "rpc");
  const server = fakeRpcServer({
    getHealth: () => Promise.reject(down),
    getLatestLedger: unexpected,
  });
  expect(await readLatestLedger(server).catch((e: unknown) => e)).toBe(down);
});

const A = "https://rpc-a.test";
const B = "https://rpc-b.test";
const realFetch = globalThis.fetch;
const realPrimary = RPC_URLS.testnet;
const realFallbacks = RPC_FALLBACKS.testnet;
const realHeaders = RPC_HEADERS.testnet;

afterEach(() => {
  globalThis.fetch = realFetch;
  RPC_URLS.testnet = realPrimary;
  RPC_FALLBACKS.testnet = realFallbacks;
  RPC_HEADERS.testnet = realHeaders;
  resetRpcCooldowns();
});

test("a provider answering unhealthy, or failing its health read, is passed over by the probe", async () => {
  const fresh = (): unknown => healthAnswer(100, Math.floor(Date.now() / 1000) - 1);
  const answers: Record<string, () => unknown>[] = [
    { [A]: () => ({ ...(fresh() as object), status: "unhealthy" }), [B]: fresh },
    { [A]: () => ({ error: { code: -32601, message: "method not found" } }), [B]: fresh },
  ];
  for (const answer of answers) {
    RPC_URLS.testnet = A;
    RPC_HEADERS.testnet = {};
    RPC_FALLBACKS.testnet = [{ url: B, headers: {} }];
    resetProviderFailoverCount();
    const hosts: string[] = [];
    globalThis.fetch = fakeFetch(async (input: string | URL | Request) => {
      const origin = new URL(typeof input === "string" ? input : input.toString()).origin;
      hosts.push(origin);
      const result = answer[origin]!();
      const body =
        result && typeof result === "object" && "error" in result
          ? { jsonrpc: "2.0", id: 1, ...result }
          : { jsonrpc: "2.0", id: 1, result };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const pin = await inRequestContext(() => pinRpcProvider("testnet"));
    expect(pin).toMatchObject({ endpoint: { url: B }, ledger: 100 });
    expect(hosts).toEqual([A, B]);
    expect(providerFailoverCount()).toBe(1);
  }
});
