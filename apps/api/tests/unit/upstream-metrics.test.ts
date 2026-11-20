import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Firestore } from "@google-cloud/firestore";
import { Keypair } from "@stellar/stellar-sdk";
import { Logger, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import {
  currentUpstreamCalls,
  currentUpstreamMs,
  requestContextMiddleware,
} from "@/common/request-context";
import { inRequestContext, requestPair } from "../support/request-context";
import { sampleTransaction } from "../support/rpc-fixtures";
import { HORIZON_FALLBACKS, PATH_ROUTING_API_URLS, type Network } from "@/config/networks";
import { fetchOctoPosPortfolio } from "@/lib/defi-positions/octopos-http";
import { horizonDepsFor, readAccountStateFrom } from "@/lib/stellar/account-state";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import {
  horizonFallbacksFor,
  recordProviderFailover,
  withHorizonFailover,
} from "@/lib/stellar/provider-failover";
import { buildRpcServer, getRpcServer } from "@/lib/stellar/rpc";
import { UpstreamError, upstreamGetJson } from "@/lib/stellar/upstream-client";
import {
  countedFetch,
  drainUpstreamCounts,
  recordUpstream,
  rpcTimingKey,
  type UpstreamDelta,
} from "@/lib/stellar/upstream-metrics";
import {
  defaultConversionDeps,
  quoteTokenToXlmOutcome,
  resetConversionSdk,
  xlmContractId,
} from "@/lib/soroswap/conversion-quotes";
import { defaultXBullConversionDeps } from "@/lib/xbull/conversion-quotes";
import { KeyActivityService } from "@/metering/key-activity.service";
import { UpstreamFlushInterceptor } from "@/metering/upstream-flush.interceptor";
import {
  UPSTREAM_BUDGET_CHECK_INTERVAL_MS,
  UPSTREAM_BUDGET_MESSAGE,
  UPSTREAM_FLUSH_INTERVAL_MS,
  UpstreamMetricsService,
} from "@/metering/upstream-metrics.service";
import { RECORD_TIMEOUT_MS } from "@/metering/metering.service";
import { FirestoreUsageStore, InMemoryUsageStore, type UsageStore } from "@/metering/usage-store";
import { OFFLINE_SOROBAN_TOKENS } from "./fixtures/fake-soroban-tokens";
import { fakeFetch } from "../support/fetch";

const BASE = "https://horizon.example";
const NO_RETRY = { client: undefined, policy: { maxRetries: 0 } };

function respondWith(status: number): typeof globalThis.fetch {
  return fakeFetch(async () => new Response("{}", { status }));
}

function counts(): Record<string, number> {
  return Object.fromEntries(
    drainUpstreamCounts().map((d) => [`${d.network}/${d.upstream}/${d.metric}`, d.count])
  );
}

beforeEach(() => {
  drainUpstreamCounts();
});

describe("counting", () => {
  test.each([
    [429, "rate_limited"],
    [503, "server_errors"],
  ])("a %d counts the request and its class", async (status, metric) => {
    await upstreamGetJson(BASE, "/x", {
      target: "horizon",
      network: "testnet",
      fetch: respondWith(status),
      ...NO_RETRY,
    }).catch(() => undefined);
    expect(counts()).toMatchObject({
      "testnet/horizon/requests": 1,
      [`testnet/horizon/${metric}`]: 1,
    });
  });

  test("a timeout counts as one, and each retry is a request of its own", async () => {
    const hang = fakeFetch(
      (_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    await upstreamGetJson(BASE, "/x", {
      target: "paths",
      network: "mainnet",
      fetch: hang,
      policy: { maxRetries: 1, perAttemptMs: 5, baseBackoffMs: 1 },
    }).catch(() => undefined);
    expect(counts()).toMatchObject({ "mainnet/paths/requests": 2, "mainnet/paths/timeouts": 2 });
  });

  test("a read that ends as unavailable counts once", async () => {
    await upstreamGetJson(BASE, "/x", {
      target: "sponsorship",
      network: "testnet",
      fetch: respondWith(500),
      ...NO_RETRY,
    }).catch(() => undefined);
    expect(counts()["testnet/horizon/unavailable"]).toBe(1);
  });

  test("a failover counts, and an exhausted list is unavailable once", async () => {
    const attempt = { baseUrl: BASE, network: "testnet" as Network };
    await expect(
      withHorizonFailover("testnet", attempt, [attempt], () =>
        Promise.reject(new UpstreamError("rate_limited", "horizon"))
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(counts()).toEqual({ "testnet/horizon/failovers": 1, "testnet/horizon/unavailable": 1 });

    recordProviderFailover("rpc", "mainnet", BASE, BASE, "probe_failed");
    expect(counts()).toEqual({ "mainnet/rpc/failovers": 1 });
  });

  test("a client-counted unavailable is not counted again when the list runs out", async () => {
    const deps = { baseUrl: BASE, network: "testnet" as Network, fetch: respondWith(500) };
    await withHorizonFailover("testnet", deps, [deps], (a) =>
      upstreamGetJson(a.baseUrl, "/x", {
        target: "horizon",
        network: "testnet",
        fetch: a.fetch,
        ...NO_RETRY,
      })
    ).catch(() => undefined);
    expect(counts()["testnet/horizon/unavailable"]).toBe(2);
  });

  test("path finding keeps its own upstream and network, and reports unavailable typed", async () => {
    const realUrl = PATH_ROUTING_API_URLS.testnet;
    const realFallbacks = HORIZON_FALLBACKS.testnet;
    PATH_ROUTING_API_URLS.testnet = BASE;
    HORIZON_FALLBACKS.testnet = [];
    try {
      const result = await fetchConversionPath(
        `USDC:${Keypair.random().publicKey()}`,
        "1",
        "testnet",
        "native",
        { fetch: respondWith(503), client: { policy: { maxRetries: 0 } } }
      );
      expect(result.kind).toBe("unavailable");
      expect(counts()).toMatchObject({
        "testnet/paths/requests": 1,
        "testnet/paths/server_errors": 1,
        "testnet/paths/unavailable": 1,
      });
    } finally {
      PATH_ROUTING_API_URLS.testnet = realUrl;
      HORIZON_FALLBACKS.testnet = realFallbacks;
    }
  });

  test("a path failover and an exhausted list land on paths, and log that kind", async () => {
    const realUrl = PATH_ROUTING_API_URLS.testnet;
    const realFallbacks = HORIZON_FALLBACKS.testnet;
    PATH_ROUTING_API_URLS.testnet = BASE;
    HORIZON_FALLBACKS.testnet = [{ url: "https://b.example", headers: {} }];
    const logged: unknown[] = [];
    const warn = spyOn(Logger.prototype, "warn").mockImplementation((line: unknown) => {
      logged.push(line);
    });
    try {
      const result = await fetchConversionPath(
        `USDC:${Keypair.random().publicKey()}`,
        "1",
        "testnet",
        "native",
        { fetch: respondWith(429), client: { policy: { maxRetries: 0 } } }
      );
      expect(result.kind).toBe("unavailable");
      const seen = counts();
      expect(seen["testnet/paths/failovers"]).toBe(1);
      expect(seen["testnet/paths/unavailable"]).toBe(1);
      expect(seen["testnet/horizon/failovers"]).toBeUndefined();
      expect(seen["testnet/horizon/unavailable"]).toBeUndefined();
      expect(logged).toContainEqual(
        expect.objectContaining({ message: "provider failover", kind: "paths" })
      );
    } finally {
      warn.mockRestore();
      PATH_ROUTING_API_URLS.testnet = realUrl;
      HORIZON_FALLBACKS.testnet = realFallbacks;
    }
  });

  test("OctoPos counts per attempt and its typed unavailable once", async () => {
    const result = await fetchOctoPosPortfolio("GADDR", {
      baseUrl: BASE,
      fetch: respondWith(400),
    });
    expect(result.ok).toBe(false);
    expect(counts()).toEqual({ "mainnet/defi/requests": 1, "mainnet/defi/unavailable": 1 });
  });

  test("the counted fetch wrapper counts a 429", async () => {
    await countedFetch("defi", "mainnet", respondWith(429))("https://x.test");
    expect(counts()).toEqual({
      "mainnet/defi/requests": 1,
      "mainnet/defi/rate_limited": 1,
    });
  });

  test("the production provider builders name their network", () => {
    const realUrl = PATH_ROUTING_API_URLS.testnet;
    const realFallbacks = HORIZON_FALLBACKS.testnet;
    PATH_ROUTING_API_URLS.testnet = BASE;
    HORIZON_FALLBACKS.testnet = [{ url: "https://b.example", headers: {} }];
    try {
      expect(horizonDepsFor("testnet").network).toBe("testnet");
      expect(horizonFallbacksFor("testnet")[0]?.network).toBe("testnet");
    } finally {
      PATH_ROUTING_API_URLS.testnet = realUrl;
      HORIZON_FALLBACKS.testnet = realFallbacks;
    }
  });
});

describe("conversion quotes", () => {
  const VARS = [
    "SOROBAN_CONVERSION_ENABLED",
    "SOROSWAP_API_KEY",
    "SOROSWAP_API_URL",
    "XBULL_CONVERSION_ENABLED",
    "XBULL_SWAP_API_URL",
  ] as const;
  let saved: Record<string, string | undefined>;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({ statusCode: 429, message: "Rate limit exceeded" }, { status: 429 }),
    });
  });

  afterEach(async () => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    resetConversionSdk();
    await server.stop(true);
  });

  test("every Soroswap quote spends quota on its network, and its rate limit is counted", async () => {
    process.env.SOROBAN_CONVERSION_ENABLED = "true";
    process.env.SOROSWAP_API_KEY = "sk_test_only";
    process.env.SOROSWAP_API_URL = `http://127.0.0.1:${server.port}`;
    resetConversionSdk();
    const token = xlmContractId("testnet");
    const outcome = await quoteTokenToXlmOutcome(token, 10n, "mainnet", defaultConversionDeps());
    expect(outcome).toEqual({ kind: "rate_limited" });
    expect(counts()).toEqual({
      "mainnet/soroswap/requests": 1,
      "mainnet/soroswap/rate_limited": 1,
    });
  });

  test("every xBull quote spends mainnet quota, and its rate limit is counted", async () => {
    process.env.XBULL_CONVERSION_ENABLED = "true";
    const doFetch = defaultXBullConversionDeps().fetch;
    if (!doFetch) throw new Error("xBull should be enabled");
    await doFetch(`http://127.0.0.1:${server.port}/quote`);
    expect(counts()).toEqual({ "mainnet/xbull/requests": 1, "mainnet/xbull/rate_limited": 1 });
  });
});

describe("rpc", () => {
  const realFetch = globalThis.fetch;
  const ADDRESS = Keypair.random().publicKey();

  /** The RPC's HTTP layer: one answer per request, the last one repeating. */
  function serve(...answers: Array<() => Response | Promise<never>>): { calls: () => number } {
    let calls = 0;
    globalThis.fetch = fakeFetch(async () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      return answer();
    });
    return { calls: () => calls };
  }
  const result = (value: unknown) => () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }), { status: 200 });
  const notFound = result({ status: "NOT_FOUND", latestLedger: 7, oldestLedger: 1 });
  const server = () => buildRpcServer("testnet", { timeout: 1000 });
  const health = async (): Promise<void> => {
    await server()
      .getHealth()
      .catch(() => undefined);
    await Promise.resolve();
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test.each([
    [429, "rate_limited"],
    [502, "server_errors"],
  ])("a %d counts its class and is not unavailable", async (status, metric) => {
    serve(() => new Response("{}", { status }));
    await health();
    expect(counts()).toEqual({ "testnet/rpc/requests": 1, [`testnet/rpc/${metric}`]: 1 });
  });

  test("a timeout counts as a timeout", async () => {
    serve(() => Promise.reject(Object.assign(new Error("late"), { name: "TimeoutError" })));
    await health();
    expect(counts()).toEqual({ "testnet/rpc/requests": 1, "testnet/rpc/timeouts": 1 });
  });

  test("a transport failure is unavailable, with or without a string code", async () => {
    serve(
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
    );
    await health();
    await health();
    expect(counts()).toEqual({ "testnet/rpc/requests": 2, "testnet/rpc/unavailable": 2 });
  });

  test("a JSON-RPC error is an answer, not a failure class", async () => {
    serve(
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }),
          { status: 200 }
        )
    );
    await health();
    expect(counts()).toEqual({ "testnet/rpc/requests": 1 });
  });

  test("a missing account is the provider's answer, not an outage", async () => {
    serve(result({ entries: [], latestLedger: 7 }));
    await expect(server().getAccount(ADDRESS)).rejects.toThrow("Account not found");
    await Promise.resolve();
    expect(counts()).toEqual({ "testnet/rpc/requests": 1 });
  });

  test("a poll counts every attempt, not the one method call", async () => {
    const { calls } = serve(notFound);
    const polled = await server().pollTransaction("00".repeat(32), {
      attempts: 3,
      sleepStrategy: () => 0,
    });
    expect(String(polled.status)).toBe("NOT_FOUND");
    expect(calls()).toBeGreaterThanOrEqual(3);
    expect(counts()).toEqual({ "testnet/rpc/requests": calls() });
  });

  test("a send is one request, and a failure is the original error", async () => {
    const { calls } = serve(() => Promise.reject(new TypeError("boom")));
    await expect(getRpcServer("testnet").sendTransaction(sampleTransaction())).rejects.toThrow(
      "boom"
    );
    await Promise.resolve();
    expect(calls()).toBe(1);
    expect(counts()).toEqual({ "testnet/rpc/requests": 1, "testnet/rpc/unavailable": 1 });
  });
});

describe("calls per request", () => {
  test("a representative account read makes exactly these calls", async () => {
    const address = Keypair.random().publicKey();
    const fetch = fakeFetch(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const account = {
        sequence: "42",
        subentry_count: 0,
        thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
        signers: [{ key: address, weight: 1, type: "ed25519_public_key" }],
        balances: [{ asset_type: "native", balance: "100.0000000" }],
        data: {},
        flags: { auth_immutable: false },
        num_sponsoring: 0,
      };
      const page = { _embedded: { records: [] } };
      return new Response(JSON.stringify(url.endsWith(address) ? account : page), {
        status: 200,
        headers: { "Latest-Ledger": "7" },
      });
    });

    const tally = await inRequestContext(async () => {
      await readAccountStateFrom(
        address,
        "testnet",
        { baseUrl: BASE, network: "testnet", fetch },
        { octopos: { baseUrl: "" }, directRead: { registryEntries: [] } },
        OFFLINE_SOROBAN_TOKENS
      );
      return Object.fromEntries(currentUpstreamCalls() ?? []);
    });
    expect(tally).toEqual({ horizon: 3 });
  });

  test("the access line carries the tally and leaves it out for a request with none", () => {
    const logged: unknown[] = [];
    const spy = spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
      logged.push(line);
    });
    try {
      const tallied = requestPair();
      requestContextMiddleware()(tallied.req, tallied.res, () => {
        recordUpstream("testnet", "rpc", "requests");
        recordUpstream("testnet", "rpc", "requests");
        recordUpstream("testnet", "horizon", "requests");
        recordUpstream("testnet", "horizon", "rate_limited");
      });
      tallied.res.emit("finish");
      expect(logged[0]).toMatchObject({ upstreamCalls: { rpc: 2, horizon: 1 } });

      const quiet = requestPair();
      requestContextMiddleware()(quiet.req, quiet.res, () => undefined);
      quiet.res.emit("finish");
      expect(logged[1]).not.toHaveProperty("upstreamCalls");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("time per upstream", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("an RPC method outside the timed set is timed as rpc.other, never under its own name", () => {
    expect(rpcTimingKey("getLedgerEntries")).toBe("rpc.getLedgerEntries");
    const address = Keypair.random().publicKey();
    for (const method of [address, `getLedgerEntries ${address}`, "toString", "", 7, undefined]) {
      expect(rpcTimingKey(method)).toBe("rpc.other");
    }
  });

  test("RPC and Horizon reads add their time under method and upstream names only", async () => {
    const address = Keypair.random().publicKey();
    globalThis.fetch = fakeFetch(async (_input: string | URL | Request, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      const result =
        method === "getHealth" ? { status: "healthy" } : { entries: [], latestLedger: 7 };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    });
    const horizon = countedFetch(
      "horizon",
      "testnet",
      fakeFetch(async () => new Response("{}", { status: 200 }))
    );
    const times = await inRequestContext(async () => {
      const server = buildRpcServer("testnet", { timeout: 1000 });
      await server.getHealth();
      await server.getAccount(address).catch(() => undefined);
      await horizon(`${BASE}/accounts/${address}`);
      return Object.fromEntries(currentUpstreamMs() ?? []);
    });
    expect(Object.keys(times).sort()).toEqual(["horizon", "rpc.getHealth", "rpc.getLedgerEntries"]);
    for (const ms of Object.values(times)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  test("the access line carries rounded times and leaves them out for a request with none", () => {
    const logged: unknown[] = [];
    const spy = spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
      logged.push(line);
    });
    try {
      const timed = requestPair();
      requestContextMiddleware()(timed.req, timed.res, () => {
        currentUpstreamMs()?.set("rpc.getEvents", 1234.6);
        currentUpstreamMs()?.set("horizon", 0.2);
      });
      timed.res.emit("finish");
      expect(logged[0]).toMatchObject({ upstreamMs: { "rpc.getEvents": 1235, horizon: 0 } });

      const quiet = requestPair();
      requestContextMiddleware()(quiet.req, quiet.res, () => undefined);
      quiet.res.emit("finish");
      expect(logged[1]).not.toHaveProperty("upstreamMs");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("durable flush", () => {
  const DAY = "2026-10-09";
  let clock: { now: Date };

  const tick = (ms = UPSTREAM_FLUSH_INTERVAL_MS): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const flushService = (store: UsageStore) => new UpstreamMetricsService(store, () => clock.now);
  const storeWith = (addUpstreamCounts: UsageStore["addUpstreamCounts"]): UsageStore => ({
    increment: async () => {},
    daily: async () => [],
    addUpstreamCounts,
    upstreamDays: async () => [],
    addRateLimited: async () => {},
  });

  beforeEach(() => {
    clock = { now: new Date(`${DAY}T12:00:00Z`) };
  });

  test("nothing is written before the interval, or when there is nothing to write", async () => {
    const writes: UpstreamDelta[][] = [];
    const service = flushService(
      storeWith(async (_, deltas) => {
        writes.push([...deltas]);
      })
    );
    recordUpstream("testnet", "rpc", "requests");
    tick(UPSTREAM_FLUSH_INTERVAL_MS - 1);
    await service.flushIfDue();
    expect(writes).toHaveLength(0);

    tick(1);
    await service.flushIfDue();
    expect(writes).toHaveLength(1);

    tick();
    await service.flushIfDue();
    expect(writes).toHaveLength(1);
  });

  test("the values survive a restart: a new instance adds to what the last one wrote", async () => {
    const store = new InMemoryUsageStore();
    recordUpstream("mainnet", "horizon", "requests");
    await flushService(store).onApplicationShutdown();

    recordUpstream("mainnet", "horizon", "requests");
    const restarted = flushService(store);
    tick();
    await restarted.flushIfDue();
    expect(store.upstream.get(`${DAY}/mainnet/horizon/requests`)).toBe(2);
  });

  test("a rejected write gives its counts back, and only one is sent per interval", async () => {
    let calls = 0;
    const service = flushService(
      storeWith(async () => {
        calls++;
        throw new Error("firestore down");
      })
    );
    recordUpstream("testnet", "rpc", "requests");
    tick();
    await service.flushIfDue();
    await service.flushIfDue();
    expect(calls).toBe(1);
    expect(counts()).toEqual({ "testnet/rpc/requests": 1 });
  });

  test("a hanging store costs one request per interval, with one write in flight", async () => {
    let calls = 0;
    let finish = (): void => undefined;
    const service = flushService(
      storeWith(() => {
        calls++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      })
    );
    recordUpstream("testnet", "rpc", "requests");
    tick();
    const started = Date.now();
    await service.flushIfDue();
    expect(Date.now() - started).toBeGreaterThanOrEqual(RECORD_TIMEOUT_MS - 50);

    const second = Date.now();
    await service.flushIfDue();
    expect(Date.now() - second).toBeLessThan(50);

    recordUpstream("testnet", "rpc", "requests");
    tick();
    const third = Date.now();
    await service.flushIfDue();
    expect(Date.now() - third).toBeLessThan(50);
    expect(calls).toBe(1);
    finish();
  });

  test("a write that outlives the cap and then lands is not counted twice", async () => {
    let land = (): void => undefined;
    const store = new InMemoryUsageStore();
    const service = flushService(
      storeWith(
        (date, deltas) =>
          new Promise<void>((resolve) => {
            land = () => {
              void store.addUpstreamCounts(date, deltas).then(resolve);
            };
          })
      )
    );
    recordUpstream("testnet", "rpc", "requests");
    tick();
    await service.flushIfDue();
    expect(counts()).toEqual({});

    land();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(counts()).toEqual({});
    expect(store.upstream.get(`${DAY}/testnet/rpc/requests`)).toBe(1);
  });

  describe("budget alerts", () => {
    // The committed budget for mainnet RPC is 100,000 requests a month: 70 percent is 70,000.
    const seed = (store: InMemoryUsageStore, date: string, count: number) =>
      store.addUpstreamCounts(date, [
        { network: "mainnet", upstream: "rpc", metric: "requests", count },
      ]);
    let warn: ReturnType<typeof spyOn>;
    const lines = (): unknown[] => warn.mock.calls.map((call: unknown[]) => call[0]);
    const budgetLines = () =>
      lines().filter(
        (line): line is Record<string, unknown> =>
          typeof line === "object" && line !== null && "provider" in line
      );

    beforeEach(() => {
      warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    test("nothing is logged below 70 percent of a budget", async () => {
      const store = new InMemoryUsageStore();
      await seed(store, DAY, 69_998);
      const service = flushService(store);
      recordUpstream("mainnet", "rpc", "requests");
      tick();
      await service.flushIfDue();
      expect(store.upstream.get(`${DAY}/mainnet/rpc/requests`)).toBe(69_999);
      expect(budgetLines()).toEqual([]);
    });

    test("at 70 percent one line names the budget, with the figures as fields", async () => {
      const store = new InMemoryUsageStore();
      await seed(store, DAY, 69_999);
      await seed(store, "2026-09-30", 50_000);
      const service = flushService(store);
      recordUpstream("mainnet", "rpc", "requests");
      tick();
      await service.flushIfDue();
      expect(budgetLines()).toEqual([
        {
          message: UPSTREAM_BUDGET_MESSAGE,
          provider: "Stellar RPC (mainnet list)",
          networks: ["mainnet"],
          upstreams: ["rpc"],
          percent: 70,
          used: 70_000,
          budget: 100_000,
        },
      ]);
    });

    test("one process checks at most once an hour, however often it writes", async () => {
      const store = new InMemoryUsageStore();
      await seed(store, DAY, 80_000);
      let reads = 0;
      const read = store.upstreamDays.bind(store);
      store.upstreamDays = (dates) => {
        reads++;
        return read(dates);
      };
      const service = flushService(store);
      const writeOnce = async (ms: number) => {
        recordUpstream("mainnet", "rpc", "requests");
        tick(ms);
        await service.flushIfDue();
      };
      await writeOnce(UPSTREAM_FLUSH_INTERVAL_MS);
      await writeOnce(UPSTREAM_FLUSH_INTERVAL_MS);
      await writeOnce(UPSTREAM_BUDGET_CHECK_INTERVAL_MS - 2 * UPSTREAM_FLUSH_INTERVAL_MS);
      expect(reads).toBe(1);
      expect(budgetLines()).toHaveLength(1);
      await writeOnce(UPSTREAM_FLUSH_INTERVAL_MS);
      expect(reads).toBe(2);
      expect(budgetLines()).toHaveLength(2);
    });

    test("a failed read is logged once, keeps the written counts and waits for the next hour", async () => {
      const store = new InMemoryUsageStore();
      let reads = 0;
      store.upstreamDays = async () => {
        reads++;
        throw new Error("firestore down");
      };
      const service = flushService(store);
      recordUpstream("mainnet", "rpc", "requests");
      tick();
      await service.flushIfDue();
      recordUpstream("mainnet", "rpc", "requests");
      tick();
      await service.flushIfDue();
      expect(reads).toBe(1);
      expect(store.upstream.get(`${DAY}/mainnet/rpc/requests`)).toBe(2);
      expect(counts()).toEqual({});
      expect(lines()).toContain("upstream_budget_check_failed: firestore down");
    });

    test("a write that fails runs no check", async () => {
      let reads = 0;
      const service = flushService({
        ...storeWith(async () => {
          throw new Error("firestore down");
        }),
        upstreamDays: async () => {
          reads++;
          return [];
        },
      });
      recordUpstream("mainnet", "rpc", "requests");
      tick();
      await service.flushIfDue();
      expect(reads).toBe(0);
    });
  });

  test("a write that outlives the cap and then rejects gives its counts back once", async () => {
    let fail = (): void => undefined;
    const service = flushService(
      storeWith(
        () =>
          new Promise<void>((_, reject) => {
            fail = () => reject(new Error("deadline exceeded"));
          })
      )
    );
    recordUpstream("testnet", "rpc", "requests");
    tick();
    await service.flushIfDue();
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counts()).toEqual({ "testnet/rpc/requests": 1 });
  });

  test("Firestore gets one merged document, by increment", async () => {
    const writes: Array<{ path: string; data: Record<string, unknown>; merge: unknown }> = [];
    const collection = (name: string) => ({
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>, options: unknown) => {
          writes.push({ path: `${name}/${id}`, data, merge: options });
        },
      }),
    });
    const firestore = new Firestore({ projectId: "usage-test-project" });
    Reflect.set(firestore, "collection", collection);
    const store = new FirestoreUsageStore(firestore);
    await store.addUpstreamCounts(DAY, [
      { network: "mainnet", upstream: "horizon", metric: "requests", count: 3 },
      { network: "mainnet", upstream: "horizon", metric: "rate_limited", count: 1 },
      { network: "testnet", upstream: "rpc", metric: "requests", count: 2 },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`upstreamUsage/${DAY}`);
    expect(writes[0]?.merge).toEqual({ merge: true });
    const written = writes[0]?.data.counts as Record<string, Record<string, object>>;
    expect(Object.keys(written.mainnet?.horizon ?? {})).toEqual(["requests", "rate_limited"]);
    expect(Object.keys(written.testnet?.rpc ?? {})).toEqual(["requests"]);
  });

  describe("interceptor", () => {
    function run(path: string, handle: CallHandler["handle"]) {
      const flushes = { count: 0, activity: 0 };
      const metrics = {
        flushIfDue: async () => {
          flushes.count++;
        },
      } as unknown as UpstreamMetricsService;
      const activity = {
        flushIfDue: async () => {
          flushes.activity++;
        },
      } as unknown as KeyActivityService;
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ path }) }),
      } as unknown as ExecutionContext;
      const result = firstValueFrom(
        new UpstreamFlushInterceptor(metrics, activity).intercept(context, { handle })
      );
      return { flushes, result };
    }

    test("flushes after a success", async () => {
      const { flushes, result } = run("/v1/testnet/analyze", () => of({ ok: true }));
      expect(await result).toEqual({ ok: true });
      expect(flushes).toEqual({ count: 1, activity: 1 });
    });

    test("flushes after a failure and still surfaces it", async () => {
      const boom = new Error("boom");
      const { flushes, result } = run("/v1/testnet/analyze", () => throwError(() => boom));
      await expect(result).rejects.toBe(boom);
      expect(flushes).toEqual({ count: 1, activity: 1 });
    });

    test("never runs for the health routes", async () => {
      for (const path of ["/health", "/health/deep", "/health/dependencies"]) {
        const { flushes, result } = run(path, () => of({ status: "ok" }));
        await result;
        expect(flushes.count).toBe(0);
      }
    });
  });
});

afterEach(() => {
  drainUpstreamCounts();
});
