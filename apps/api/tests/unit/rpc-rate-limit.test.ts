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
import { inRequestContext } from "../support/request-context";
import { REQUEST_DEADLINE_MS, SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS } from "@/config/constants";
import { RPC_FALLBACKS, RPC_HEADERS, RPC_URLS } from "@/config/networks";
import { mapDomainError, PLAN_ERRORS, UPSTREAM_ERRORS } from "@/lib/close-api/domain-errors";
import { getRpcServer, readLatestLedger, resetRpcCooldowns } from "@/lib/stellar/rpc";
import { providerFailoverCount, resetProviderFailoverCount } from "@/lib/stellar/provider-failover";
import { submitAndWait } from "@/lib/stellar/submit";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { drainUpstreamCounts } from "@/lib/stellar/upstream-metrics";
import { fakeFetch } from "../support/fetch";

const A = "https://rpc-a.test";
const B = "https://rpc-b.test";

const HEADER_XDR = Buffer.alloc(4 + 32 + 48 + 32 + 32 + 4 + 8 + 8 + 4 + 8 + 4 + 4 + 4 + 128 + 4);
const META_XDR = Buffer.alloc(4 + 32 + HEADER_XDR.length + 4 + 32 + 4 + 4 + 4 + 4);

/** A JSON-RPC result, an HTTP error status, a thrown fetch failure, or a raw 200 body. */
type Reply =
  | { result: unknown }
  | { status: number; retryAfter?: string }
  | { hangs: true }
  | { rpcError: string }
  | { throws: Error }
  | { raw: () => ConstructorParameters<typeof Response>[0] };
type Handler = (method: string) => Reply;

interface Call {
  host: string;
  method: string;
}

function fakeRpc(hosts: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = fakeFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ host: url.origin, method });
    const reply = hosts[url.origin]!(method);
    if ("throws" in reply) throw reply.throws;
    if ("hangs" in reply) return new Promise<Response>(() => undefined);
    if ("status" in reply) {
      const headers: Record<string, string> =
        reply.retryAfter === undefined ? {} : { "Retry-After": reply.retryAfter };
      return new Response("busy", { status: reply.status, headers });
    }
    if ("raw" in reply) return new Response(reply.raw(), { status: 200 });
    const body =
      "rpcError" in reply
        ? { jsonrpc: "2.0", id: 1, error: { code: -32602, message: reply.rpcError } }
        : { jsonrpc: "2.0", id: 1, result: reply.result };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
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

function health(sequence: number) {
  return {
    status: "healthy",
    latestLedger: sequence,
    latestLedgerCloseTime: String(Math.floor(Date.now() / 1000) - 1),
  };
}

/** Fresh on the probe; `entries` answers every other method. */
const provider =
  (entries: Reply): Handler =>
  (method) =>
    method === "getHealth" ? { result: health(100) } : entries;

const EMPTY_ENTRIES: Reply = { result: { entries: [], latestLedger: 100 } };
const RATE_LIMITED: Reply = { status: 429 };

/** Headers, then a body that never completes: the SDK's client reads it as no data at all. */
const CUT_OFF: Reply = {
  raw: () =>
    new ReadableStream({
      start(controller) {
        controller.error(new Error("socket closed mid-body"));
      },
    }),
};

const KEY = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() })
);

const readEntries = (): Promise<unknown> =>
  inRequestContext(() => getRpcServer("testnet").getLedgerEntries(KEY)).catch((e: unknown) => e);

/** The testnet RPC failure counts recorded since the last drain, requests left out. */
const rpcFailureCounts = (): Record<string, number> =>
  Object.fromEntries(
    drainUpstreamCounts()
      .filter((d) => d.network === "testnet" && d.upstream === "rpc" && d.metric !== "requests")
      .map((d) => [d.metric, d.count])
  );

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
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
  expect(providerFailoverCount()).toBe(0);
});

test("a missing account whose address spells TIMEOUT is still the SDK's not-found", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider(EMPTY_ENTRIES) });
  const address = "GAJA7Z7F5HTIMEOUTCBAH5EG6GJNI7U2BJL4Z7GTYMTN4DGXUL4VNHIK";
  const failure = await inRequestContext(() => getRpcServer("testnet").getAccount(address)).catch(
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
  expect(hostsOf(calls, "getHealth")).toEqual([B, A]);
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
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a cooldown outlasts a Retry-After counted from the end of the deadline, then ends", async () => {
  useProviders(A, B);
  const start = Date.now();
  setSystemTime(start);
  fakeRpc({ [A]: provider(RATE_LIMITED), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();

  const retryAt = start + REQUEST_DEADLINE_MS + SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS * 1000;
  setSystemTime(retryAt - 1);
  let calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([B]);

  setSystemTime(retryAt);
  calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a timeout is typed but starts no cooldown", async () => {
  useProviders(A, B);
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  fakeRpc({ [A]: provider({ throws: timeout }), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ kind: "timeout" });
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("an answer with no JSON-RPC envelope is a typed unavailable, never the SDK's TypeError", async () => {
  const bodies = ["null", "", "<html>bad gateway</html>", "[]", '{"jsonrpc":"2.0","id":1}'];
  for (const answer of [CUT_OFF, ...bodies.map((body): Reply => ({ raw: () => body }))]) {
    const lone = useLoneProvider();
    fakeRpc({ [lone]: provider(answer) });
    const failure = await readEntries();
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ kind: "unavailable" });
    expect(mapDomainError(PLAN_ERRORS, failure)).toMatchObject({ status: 503 });
  }
});

test("a provider that answered with no envelope ends this request and is skipped by the next", async () => {
  useProviders(A, B);
  drainUpstreamCounts();
  let calls = fakeRpc({ [A]: provider(CUT_OFF), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ kind: "unavailable" });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([A]);
  expect(rpcFailureCounts()).toEqual({ unavailable: 1 });

  calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(calls.map((c) => c.host)).toEqual([B, B]);
  expect(providerFailoverCount()).toBe(1);
});

test("a probe answered with no envelope fails over within the request", async () => {
  useProviders(A, B);
  const calls = fakeRpc({
    [A]: (method) => (method === "getHealth" ? CUT_OFF : EMPTY_ENTRIES),
    [B]: provider(EMPTY_ENTRIES),
  });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getHealth")).toEqual([A, B]);
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([B]);
});

test("an enveloped answer the SDK cannot parse stays untyped and cools nothing", async () => {
  useProviders(A, B);
  fakeRpc({
    [A]: provider({ result: { entries: [{}], latestLedger: 100 } }),
    [B]: provider(EMPTY_ENTRIES),
  });
  const failure = await readEntries();
  expect(failure).toBeInstanceOf(TypeError);
  expect(failure).not.toBeInstanceOf(UpstreamError);
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
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
  const failure = await inRequestContext(() =>
    getRpcServer("testnet").sendTransaction(signedTransaction())
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(UpstreamError);
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a send answered with no envelope stays untyped, says nothing raw and starts no cooldown", async () => {
  useProviders(A, B);
  fakeRpc({
    [A]: (method) => (method === "sendTransaction" ? CUT_OFF : provider(EMPTY_ENTRIES)(method)),
    [B]: provider(EMPTY_ENTRIES),
  });
  const failure = await inRequestContext(() =>
    getRpcServer("testnet").sendTransaction(signedTransaction())
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(UpstreamError);
  expect((failure as Error).message).toBe("The data provider sent an incomplete answer.");
  const calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a rate-limited by-hash check before a submit sends nothing", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: provider(RATE_LIMITED) });
  const send = spyOn(rpc.Server.prototype, "sendTransaction");
  try {
    const failure = await inRequestContext(() =>
      submitAndWait(signedTransaction().toXDR(), "testnet")
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "rate_limited" });
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
  }
});

/** Answers `method` with each reply in turn, the last one from then on; fresh on every probe. */
function scripted(method: string, ...replies: Reply[]): Handler {
  let served = 0;
  return (asked) => {
    if (asked !== method) return provider(EMPTY_ENTRIES)(asked);
    const reply = replies[Math.min(served, replies.length - 1)]!;
    served += 1;
    return reply;
  };
}

const ASKS_SHORT_WAIT: Reply = { status: 429, retryAfter: "0.05" };

test("a ledger read refused with a short Retry-After is answered by its one retry", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({ [lone]: scripted("getLedgerEntries", ASKS_SHORT_WAIT, EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([lone, lone]);
});

test("a latest-ledger read refused with a short Retry-After is answered by its one retry", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({
    [lone]: scripted("getLatestLedger", ASKS_SHORT_WAIT, { result: latestLedger(100) }),
  });
  const latest = await inRequestContext(() => getRpcServer("testnet").getLatestLedger());
  expect(latest.sequence).toBe(100);
  expect(hostsOf(calls, "getLatestLedger")).toEqual([lone, lone]);
});

test("a health read refused with a short Retry-After is answered by its one retry", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({
    [lone]: scripted("getHealth", ASKS_SHORT_WAIT, { result: health(100) }),
  });
  const latest = await inRequestContext(() => readLatestLedger(getRpcServer("testnet")));
  expect(latest.sequence).toBe(100);
  expect(hostsOf(calls, "getHealth")).toEqual([lone, lone]);
});

test("a probe refused with a short Retry-After is not retried before the next provider", async () => {
  useProviders(A, B);
  const calls = fakeRpc({
    [A]: scripted("getHealth", ASKS_SHORT_WAIT, { result: health(100) }),
    [B]: provider(EMPTY_ENTRIES),
  });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getHealth")).toEqual([A, B]);
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([B]);
});

test("with several providers the retry stays on the pinned one and cools nothing", async () => {
  useProviders(A, B);
  let calls = fakeRpc({
    [A]: scripted("getLedgerEntries", ASKS_SHORT_WAIT, EMPTY_ENTRIES),
    [B]: provider(EMPTY_ENTRIES),
  });
  expect(await readEntries()).toMatchObject({ entries: [] });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([A, A]);
  calls = fakeRpc({ [A]: provider(EMPTY_ENTRIES), [B]: provider(EMPTY_ENTRIES) });
  await readEntries();
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a second refusal is not retried again", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({ [lone]: scripted("getLedgerEntries", ASKS_SHORT_WAIT) });
  expect(await readEntries()).toMatchObject({ kind: "rate_limited" });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([lone, lone]);
});

test("a refusal without Retry-After is not retried", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({ [lone]: scripted("getLedgerEntries", RATE_LIMITED, EMPTY_ENTRIES) });
  expect(await readEntries()).toMatchObject({ kind: "rate_limited" });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([lone]);
});

test("a Retry-After that ends past the request's deadline is not waited for", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({
    [lone]: scripted("getLedgerEntries", { status: 429, retryAfter: "1" }, EMPTY_ENTRIES),
  });
  const started = Date.now();
  const failure = await inRequestContext(
    () => getRpcServer("testnet").getLedgerEntries(KEY),
    300
  ).catch((e: unknown) => e);
  expect(failure).toMatchObject({ kind: "rate_limited" });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([lone]);
});

test("a retry that does not answer still ends at the request's deadline", async () => {
  const lone = useLoneProvider();
  fakeRpc({ [lone]: scripted("getLedgerEntries", ASKS_SHORT_WAIT, { hangs: true }) });
  const started = Date.now();
  const failure = await inRequestContext(
    () => getRpcServer("testnet").getLedgerEntries(KEY),
    300
  ).catch((e: unknown) => e);
  expect(failure).toMatchObject({ kind: "timeout" });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("outside a request a refusal is not retried", async () => {
  const lone = useLoneProvider();
  const calls = fakeRpc({ [lone]: scripted("getLedgerEntries", ASKS_SHORT_WAIT, EMPTY_ENTRIES) });
  const failure = await getRpcServer("testnet")
    .getLedgerEntries(KEY)
    .catch((e: unknown) => e);
  expect(failure).toMatchObject({ kind: "rate_limited" });
  expect(hostsOf(calls, "getLedgerEntries")).toEqual([lone]);
});

test("a send and a simulation refused with a short Retry-After are sent once", async () => {
  const setups = [useLoneProvider, () => (useProviders(A, B), A)];
  for (const [method, setup] of setups.flatMap((s) =>
    (["sendTransaction", "simulateTransaction"] as const).map((m) => [m, s] as const)
  )) {
    resetRpcCooldowns();
    const lone = setup();
    const calls = fakeRpc({
      [lone]: scripted(method, ASKS_SHORT_WAIT, EMPTY_ENTRIES),
      [B]: provider(EMPTY_ENTRIES),
    });
    const server = getRpcServer("testnet");
    await inRequestContext((): Promise<unknown> =>
      method === "sendTransaction"
        ? server.sendTransaction(signedTransaction())
        : server.simulateTransaction(signedTransaction())
    ).catch((e: unknown) => e);
    expect(hostsOf(calls, method)).toEqual([lone]);
  }
});
