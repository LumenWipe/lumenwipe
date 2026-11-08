import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { requestContextMiddleware } from "@/common/request-context";
import { RPC_PROVIDER_COOLDOWN_MS } from "@/config/constants";
import { RPC_FALLBACKS, RPC_HEADERS, RPC_URLS } from "@/config/networks";
import { mapDomainError, PLAN_ERRORS, UPSTREAM_ERRORS } from "@/lib/close-api/domain-errors";
import { getRpcServer, resetRpcCooldowns } from "@/lib/stellar/rpc";
import { providerFailoverCount, resetProviderFailoverCount } from "@/lib/stellar/provider-failover";
import { submitAndWait } from "@/lib/stellar/submit";
import { UpstreamError } from "@/lib/stellar/upstream-client";

const A = "https://rpc-a.test";
const B = "https://rpc-b.test";

const HEADER_XDR = Buffer.alloc(4 + 32 + 48 + 32 + 32 + 4 + 8 + 8 + 4 + 8 + 4 + 4 + 4 + 128 + 4);
const META_XDR = Buffer.alloc(4 + 32 + HEADER_XDR.length + 4 + 32 + 4 + 4 + 4 + 4);

/** A JSON-RPC result, an HTTP error status, or a thrown fetch failure. */
type Reply = { result: unknown } | { status: number } | { rpcError: string } | { throws: Error };
type Handler = (method: string) => Reply;

interface Call {
  host: string;
  method: string;
}

function fakeRpc(hosts: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ host: url.origin, method });
    const reply = hosts[url.origin]!(method);
    if ("throws" in reply) throw reply.throws;
    if ("status" in reply) return new Response("busy", { status: reply.status });
    const body =
      "rpcError" in reply
        ? { jsonrpc: "2.0", id: 1, error: { code: -32602, message: reply.rpcError } }
        : { jsonrpc: "2.0", id: 1, result: reply.result };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function latestLedger(sequence: number) {
  return {
    id: "synthetic",
    sequence,
    protocolVersion: 23,
    closeTime: String(Math.floor(Date.now() / 1000) - 1),
    headerXdr: HEADER_XDR.toString("base64"),
    metadataXdr: META_XDR.toString("base64"),
  };
}

/** Fresh on the probe; `entries` answers every other method. */
const provider =
  (entries: Reply): Handler =>
  (method) =>
    method === "getLatestLedger" ? { result: latestLedger(100) } : entries;

const EMPTY_ENTRIES: Reply = { result: { entries: [], latestLedger: 100 } };
const RATE_LIMITED: Reply = { status: 429 };

const KEY = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() })
);

function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const res = { setHeader() {}, json() {}, on() {} };
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware()({ path: "/x" } as never, res as never, () => {
      run().then(resolve, reject);
    })
  );
}

const readEntries = (): Promise<unknown> =>
  inRequest(() => getRpcServer("testnet").getLedgerEntries(KEY)).catch((e: unknown) => e);

const hostsOf = (calls: Call[], method: string): string[] =>
  calls.filter((c) => c.method === method).map((c) => c.host);

const realFetch = globalThis.fetch;
const realPrimary = RPC_URLS.testnet;
const realFallbacks = RPC_FALLBACKS.testnet;
const realHeaders = RPC_HEADERS.testnet;

function useProviders(...urls: string[]): void {
  RPC_URLS.testnet = urls[0]!;
  RPC_HEADERS.testnet = {};
  RPC_FALLBACKS.testnet = urls.slice(1).map((url) => ({ url, headers: {} }));
}

/**
 * A one-entry list reads the memoized server, whose URL is whatever the first caller in this process
 * saw; the stub answers on that origin instead of assuming it.
 */
function useLoneProvider(): string {
  const origin = getRpcServer("testnet").serverURL.origin;
  useProviders(origin);
  return origin;
}

beforeEach(() => {
  resetRpcCooldowns();
  resetProviderFailoverCount();
});

afterEach(() => {
  resetRpcCooldowns();
  setSystemTime();
  globalThis.fetch = realFetch;
  RPC_URLS.testnet = realPrimary;
  RPC_FALLBACKS.testnet = realFallbacks;
  RPC_HEADERS.testnet = realHeaders;
});

test("a 429 from a lone provider is a typed rate limit that every route answers as a 503", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider(RATE_LIMITED) });
  const failure = await readEntries();
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "rate_limited" });
  for (const table of [UPSTREAM_ERRORS, PLAN_ERRORS]) {
    const mapped = mapDomainError(table, failure);
    expect(mapped).toMatchObject({ code: "service_unavailable", status: 503 });
    expect(mapped!.message).not.toContain(new URL(lone).host);
  }
});

test("a 503 from the provider is a typed unavailable", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider({ status: 503 }) });
  expect(await readEntries()).toMatchObject({ kind: "unavailable" });
});

test("a read that times out is a typed timeout", async () => {
  const lone = useLoneProvider();
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  fakeRpc({ [lone]: provider({ throws: timeout }) });
  expect(await readEntries()).toMatchObject({ kind: "timeout" });
});

test("a JSON-RPC error and a 4xx are the provider's answer: passed through, no cooldown", async () => {
  for (const answer of [{ rpcError: "invalid key" }, { status: 400 }] as Reply[]) {
    const lone = useLoneProvider();
    fakeRpc({ [lone]: provider(answer) });
    const failure = await readEntries();
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(UpstreamError);
  }
  useProviders(A, B);
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
  expect(providerFailoverCount()).toBe(0);
});

test("a missing account whose address spells TIMEOUT is still the SDK's not-found", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider(EMPTY_ENTRIES) });
  const address = "GAJA7Z7F5HTIMEOUTCBAH5EG6GJNI7U2BJL4Z7GTYMTN4DGXUL4VNHIK";
  const failure = await inRequest(() => getRpcServer("testnet").getAccount(address)).catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(UpstreamError);
  expect((failure as Error).message).toContain(address);
});

test("a cooling provider is still probed after every ready one fails", async () => {
  useProviders(A, B);
  fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: () => ({ status: 503 }) });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getLatestLedger")).toEqual([B, A]);
});

test("a rate-limited provider answers this request with a 503 and is skipped by the next", async () => {
  useProviders(A, B);
  let calls = fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ kind: "rate_limited" });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([A]);

  calls = fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(calls.map((c) => c.host)).toEqual([B, B]);
  expect(providerFailoverCount()).toBe(1);
});

test("with every provider cooling down, the probe walks the whole list from the primary", async () => {
  useProviders(A, B);
  fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(RATE_LIMITED) });
  await readEntries();
  await readEntries();
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
});

test("a cooldown ends after its window", async () => {
  useProviders(A, B);
  const start = Date.now();
  setSystemTime(start);
  fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();

  setSystemTime(start + RPC_PROVIDER_COOLDOWN_MS - 1);
  let calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([B]);

  setSystemTime(start + RPC_PROVIDER_COOLDOWN_MS);
  calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
});

test("a timeout is typed but starts no cooldown", async () => {
  useProviders(A, B);
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  fakeRpc({ [A]: provider({ throws: timeout }), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ kind: "timeout" });
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
});

const SOURCE = Keypair.random();

function signedTransaction() {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx;
}

test("a rate-limited send keeps its untyped error and starts no cooldown", async () => {
  useProviders(A, B);
  fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  const failure = await inRequest(() =>
    getRpcServer("testnet").sendTransaction(signedTransaction())
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(UpstreamError);
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
});

test("a rate-limited by-hash check before a submit sends nothing", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider(RATE_LIMITED) });
  const send = spyOn(rpc.Server.prototype, "sendTransaction");
  try {
    const failure = await inRequest(() =>
      submitAndWait(signedTransaction().toXDR(), "testnet")
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "rate_limited" });
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
  }
});
