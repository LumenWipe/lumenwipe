import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { requestContextMiddleware } from "@/common/request-context";
import { RPC_FALLBACKS, RPC_HEADERS, RPC_URLS } from "@/config/networks";
import { blendSdkNetwork } from "@/lib/blend-sdk";
import {
  getRpcServer,
  nextRpcServer,
  pinnedRpcProvider,
  pinRpcProvider,
  rpcReferenceLedger,
} from "@/lib/stellar/rpc";
import { providerFailoverCount, resetProviderFailoverCount } from "@/lib/stellar/provider-failover";
import { submitAndWait } from "@/lib/stellar/submit";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { TxSubmitError } from "@/lib/utils/errors";

const A = "https://rpc-a.test";
const B = "https://rpc-b.test";
const C = "https://rpc-c.test";

// All-zero bytes are a valid header and a valid empty v0 close meta; the probe reads neither.
const HEADER_XDR = Buffer.alloc(4 + 32 + 48 + 32 + 32 + 4 + 8 + 8 + 4 + 8 + 4 + 4 + 4 + 128 + 4);
const META_XDR = Buffer.alloc(4 + 32 + HEADER_XDR.length + 4 + 32 + 4 + 4 + 4 + 4);

function latestLedger(sequence: number, ageSeconds = 1) {
  return {
    id: "synthetic",
    sequence,
    protocolVersion: 23,
    closeTime: String(Math.floor(Date.now() / 1000) - ageSeconds),
    headerXdr: HEADER_XDR.toString("base64"),
    metadataXdr: META_XDR.toString("base64"),
  };
}

interface Call {
  host: string;
  method: string;
  headers: Headers;
}

type Handler = (method: string) => unknown;

/** An injected fetch speaking JSON-RPC; a handler that throws is a dead provider. */
function fakeRpc(hosts: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ host: url.origin, method, headers: new Headers(init?.headers) });
    const result = hosts[url.origin]!(method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const dead: Handler = () => {
  throw new Error("connection refused");
};

const alive =
  (sequence: number, ageSeconds = 1): Handler =>
  (method) =>
    method === "getLatestLedger" ? latestLedger(sequence, ageSeconds) : { status: "healthy" };

function inRequest<T>(run: () => Promise<T>, deadlineMs?: number): Promise<T> {
  const res = { setHeader() {}, json() {}, on() {} };
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware(deadlineMs)({ path: "/x" } as never, res as never, () => {
      run().then(resolve, reject);
    })
  );
}

const realFetch = globalThis.fetch;
const realPrimary = RPC_URLS.testnet;
const realFallbacks = RPC_FALLBACKS.testnet;
const realHeaders = RPC_HEADERS.testnet;

beforeEach(() => {
  resetProviderFailoverCount();
  RPC_URLS.testnet = A;
  RPC_FALLBACKS.testnet = [{ url: B, headers: {} }];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  RPC_URLS.testnet = realPrimary;
  RPC_FALLBACKS.testnet = realFallbacks;
  RPC_HEADERS.testnet = realHeaders;
});

const hostsOf = (calls: Call[], method: string): string[] =>
  calls.filter((c) => c.method === method).map((c) => c.host);

test("with the first URL failing, a read succeeds against the second", async () => {
  const calls = fakeRpc({ [A]: dead, [B]: alive(100) });
  const health = await inRequest(() => getRpcServer("testnet").getHealth());
  expect(health.status).toBe("healthy");
  expect(hostsOf(calls, "getHealth")).toEqual([B]);
  expect(providerFailoverCount()).toBe(1);
});

test("with every URL failing, the caller gets the typed unavailable", async () => {
  fakeRpc({ [A]: dead, [B]: dead });
  const failure = await inRequest(() => getRpcServer("testnet").getHealth()).catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "unavailable" });
});

test("a provider whose newest ledger is old is passed over; a recent one is pinned", async () => {
  const calls = fakeRpc({ [A]: alive(90, 45), [B]: alive(100, 25) });
  const pin = await inRequest(() => pinRpcProvider("testnet"));
  expect(pin).toMatchObject({ endpoint: { url: B }, ledger: 100 });
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A, B]);
});

test("a ledger with no readable close time cannot prove a provider is fresh", async () => {
  fakeRpc({
    [A]: (method) => ({ ...latestLedger(90), closeTime: "not-a-time", method }),
    [B]: alive(100),
  });
  expect((await inRequest(() => pinRpcProvider("testnet"))).endpoint.url).toBe(B);
});

test("the pin holds for the whole request: a primary dying mid-request is not failed over", async () => {
  let primaryDead = false;
  const primary: Handler = (method) => {
    if (primaryDead) throw new Error("connection refused");
    return alive(100)(method);
  };
  const calls = fakeRpc({ [A]: primary, [B]: alive(100) });
  await inRequest(async () => {
    const server = getRpcServer("testnet");
    await Promise.all([server.getHealth(), server.getHealth()]);
    primaryDead = true;
    await expect(server.getHealth()).rejects.toBeDefined();
  });
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A]);
  expect(hostsOf(calls, "getHealth")).toEqual([A, A, A]);
});

test("each request settles its own provider", async () => {
  const calls = fakeRpc({ [A]: alive(100), [B]: alive(100) });
  await inRequest(() => getRpcServer("testnet").getHealth());
  await inRequest(() => getRpcServer("testnet").getHealth());
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A, A]);
});

test("outside a request the primary is used, with no probe", async () => {
  const calls = fakeRpc({ [A]: alive(100), [B]: alive(100) });
  expect(await pinRpcProvider("testnet")).toMatchObject({ endpoint: { url: A }, ledger: null });
  await getRpcServer("testnet").getHealth();
  expect(hostsOf(calls, "getLatestLedger")).toEqual([]);
  expect(hostsOf(calls, "getHealth")).toEqual([A]);
});

test("a one-entry list probes nothing and keeps its singleton", async () => {
  RPC_FALLBACKS.testnet = [];
  const send = spyOn(rpc.Server.prototype, "getHealth").mockResolvedValue({
    status: "healthy",
  } as never);
  const latest = spyOn(rpc.Server.prototype, "getLatestLedger");
  try {
    const server = await inRequest(async () => {
      const shared = getRpcServer("testnet");
      await shared.getHealth();
      return shared;
    });
    expect(server).toBe(getRpcServer("testnet"));
    expect(await inRequest(() => pinRpcProvider("testnet"))).toMatchObject({ ledger: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(providerFailoverCount()).toBe(0);
  } finally {
    send.mockRestore();
    latest.mockRestore();
  }
});

test("each provider gets its own headers and no other's", async () => {
  RPC_HEADERS.testnet = { "x-primary-key": "synthetic-a" };
  RPC_FALLBACKS.testnet = [{ url: B, headers: { "x-fallback-key": "synthetic-b" } }];
  const calls = fakeRpc({ [A]: dead, [B]: alive(100) });
  await inRequest(() => getRpcServer("testnet").getHealth());
  const onA = calls.filter((c) => c.host === A);
  const onB = calls.filter((c) => c.host === B);
  expect(onA.length).toBeGreaterThan(0);
  expect(onB.length).toBeGreaterThan(0);
  for (const call of onA) expect(call.headers.get("x-primary-key")).toBe("synthetic-a");
  for (const call of onB) {
    expect(call.headers.get("x-primary-key")).toBeNull();
    expect(call.headers.get("x-fallback-key")).toBe("synthetic-b");
  }
});

test("the Blend SDK sees the pinned URL with that provider's headers once the pin settled", async () => {
  RPC_HEADERS.testnet = { "x-primary-key": "synthetic-a" };
  RPC_FALLBACKS.testnet = [{ url: B, headers: { "x-fallback-key": "synthetic-b" } }];
  fakeRpc({ [A]: dead, [B]: alive(100) });
  const network = await inRequest(async () => {
    expect(blendSdkNetwork("testnet").rpc).toBe(A);
    await pinRpcProvider("testnet");
    return blendSdkNetwork("testnet");
  });
  expect(network.rpc).toBe(B);
  expect(network.opts?.headers).toEqual({ "x-fallback-key": "synthetic-b" });
});

test("the reference ledger is the pin's, or a read on a lone provider", async () => {
  const calls = fakeRpc({ [A]: dead, [B]: alive(100) });
  expect(await inRequest(() => rpcReferenceLedger("testnet"))).toBe(100);
  expect(hostsOf(calls, "getLatestLedger")).toEqual([A, B]);

  RPC_FALLBACKS.testnet = [];
  const latest = spyOn(rpc.Server.prototype, "getLatestLedger");
  try {
    latest.mockResolvedValueOnce({ sequence: 55 } as never);
    expect(await rpcReferenceLedger("testnet")).toBe(55);
    latest.mockRejectedValueOnce(new Error("down"));
    await expect(rpcReferenceLedger("testnet")).rejects.toBeInstanceOf(UpstreamError);
  } finally {
    latest.mockRestore();
  }
});

test("the next provider wraps around from the last, and a lone list has none", async () => {
  RPC_FALLBACKS.testnet = [
    { url: B, headers: {} },
    { url: C, headers: {} },
  ];
  fakeRpc({ [A]: dead, [B]: dead, [C]: alive(100) });
  await inRequest(async () => {
    expect(nextRpcServer("testnet")!.serverURL.toString()).toContain("rpc-b.test");
    await pinRpcProvider("testnet");
    expect(pinnedRpcProvider("testnet").url).toBe(C);
    expect(nextRpcServer("testnet")!.serverURL.toString()).toContain("rpc-a.test");
  });
  RPC_FALLBACKS.testnet = [];
  expect(nextRpcServer("testnet")).toBeNull();
});

async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

const pastDeadline = async <T>(call: () => Promise<T>): Promise<unknown> =>
  inRequest(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return call().catch((e: unknown) => e);
  }, 1);

test("a call rejecting after the deadline passed is a typed timeout, on a lone provider", async () => {
  RPC_FALLBACKS.testnet = [];
  const health = spyOn(rpc.Server.prototype, "getHealth").mockRejectedValue(new Error("down"));
  try {
    let failure: unknown;
    const unhandled = await unhandledDuring(async () => {
      failure = await pastDeadline(() => getRpcServer("testnet").getHealth());
    });
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ kind: "timeout" });
    expect(health).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  } finally {
    health.mockRestore();
  }
});

test("a rejected pin after the deadline passed is a typed timeout, with a list", async () => {
  fakeRpc({ [A]: dead, [B]: dead });
  let failure: unknown;
  const unhandled = await unhandledDuring(async () => {
    failure = await pastDeadline(() => getRpcServer("testnet").getHealth());
  });
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "timeout" });
  expect(unhandled).toEqual([]);
});

const SOURCE = Keypair.random();

function signedXdr(): string {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx.toXDR();
}

/** Counts submit traffic per provider across every server instance. */
function submitSpies(afterSend: () => unknown) {
  const sends: string[] = [];
  const lookups: string[] = [];
  const send = spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(function (
    this: rpc.Server
  ) {
    sends.push(this.serverURL.toString());
    return Promise.reject(new Error("socket hang up"));
  });
  const lookup = spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(function (
    this: rpc.Server
  ) {
    lookups.push(this.serverURL.toString());
    return Promise.resolve(
      (sends.length === 0 ? { status: "NOT_FOUND" } : afterSend()) as rpc.Api.GetTransactionResponse
    );
  });
  return {
    sends,
    lookups,
    restore: () => {
      send.mockRestore();
      lookup.mockRestore();
    },
  };
}

test("a failed send is never replayed: one send anywhere, one by-hash look at the next provider", async () => {
  fakeRpc({ [A]: alive(100), [B]: alive(100) });
  const spies = submitSpies(() => ({ status: "NOT_FOUND" }));
  try {
    await expect(inRequest(() => submitAndWait(signedXdr(), "testnet"))).rejects.toThrow(
      "socket hang up"
    );
    expect(spies.sends).toEqual([`${A}/`]);
    expect(spies.lookups).toEqual([`${A}/`, `${B}/`]);
  } finally {
    spies.restore();
  }
});

test("the by-hash look turning up a success reports the success", async () => {
  fakeRpc({ [A]: alive(100), [B]: alive(100) });
  const spies = submitSpies(() => ({ status: "SUCCESS", ledger: 321 }));
  try {
    const result = await inRequest(() => submitAndWait(signedXdr(), "testnet"));
    expect(result.ledger).toBe(321);
    expect(spies.sends).toHaveLength(1);
  } finally {
    spies.restore();
  }
});

test("the by-hash look turning up a failure reports a rejection", async () => {
  fakeRpc({ [A]: alive(100), [B]: alive(100) });
  const spies = submitSpies(() => ({ status: "FAILED", ledger: 321 }));
  try {
    await expect(inRequest(() => submitAndWait(signedXdr(), "testnet"))).rejects.toBeInstanceOf(
      TxSubmitError
    );
    expect(spies.sends).toHaveLength(1);
  } finally {
    spies.restore();
  }
});

test("a by-hash look that itself fails leaves the original error", async () => {
  const server = {
    getTransaction: async () => ({ status: "NOT_FOUND" }),
    sendTransaction: async () => {
      throw new Error("socket hang up");
    },
  } as unknown as rpc.Server;
  const failing = {
    getTransaction: async () => {
      throw new Error("also down");
    },
  } as unknown as rpc.Server;
  await expect(
    submitAndWait(
      signedXdr(),
      "testnet",
      undefined,
      () => server,
      () => failing
    )
  ).rejects.toThrow("socket hang up");
});

test("a one-entry list keeps the plain rethrow, with no second look", async () => {
  RPC_FALLBACKS.testnet = [];
  const spies = submitSpies(() => ({ status: "SUCCESS", ledger: 1 }));
  try {
    await expect(submitAndWait(signedXdr(), "testnet")).rejects.toThrow("socket hang up");
    expect(spies.sends).toHaveLength(1);
    expect(spies.lookups).toHaveLength(1);
  } finally {
    spies.restore();
  }
});
