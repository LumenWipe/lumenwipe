import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { Logger, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import { currentUpstreamCalls, requestContextMiddleware } from "@/common/request-context";
import { HORIZON_FALLBACKS, PATH_ROUTING_API_URLS, type Network } from "@/config/networks";
import { fetchOctoPosPortfolio } from "@/lib/defi-positions/octopos-http";
import { horizonDepsFor, readAccountStateFrom } from "@/lib/stellar/account-state";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import {
  horizonFallbacksFor,
  recordProviderFailover,
  withHorizonFailover,
} from "@/lib/stellar/provider-failover";
import { countedRpcServer, getRpcServer } from "@/lib/stellar/rpc";
import { UpstreamError, upstreamGetJson } from "@/lib/stellar/upstream-client";
import {
  countedFetch,
  drainUpstreamCounts,
  recordUpstream,
  type UpstreamDelta,
} from "@/lib/stellar/upstream-metrics";
import { UpstreamFlushInterceptor } from "@/metering/upstream-flush.interceptor";
import {
  UPSTREAM_FLUSH_INTERVAL_MS,
  UpstreamMetricsService,
} from "@/metering/upstream-metrics.service";
import { RECORD_TIMEOUT_MS } from "@/metering/metering.service";
import { FirestoreUsageStore, InMemoryUsageStore, type UsageStore } from "@/metering/usage-store";
import { OFFLINE_SOROBAN_TOKENS } from "./fixtures/fake-soroban-tokens";

const BASE = "https://horizon.example";
const NO_RETRY = { client: undefined, policy: { maxRetries: 0 } };

function respondWith(status: number): typeof globalThis.fetch {
  return (async () => new Response("{}", { status })) as unknown as typeof globalThis.fetch;
}

function counts(): Record<string, number> {
  return Object.fromEntries(
    drainUpstreamCounts().map((d) => [`${d.network}/${d.upstream}/${d.metric}`, d.count])
  );
}

function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const res = { setHeader() {}, json() {}, on() {} };
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware()({ path: "/x" } as never, res as never, () => {
      run().then(resolve, reject);
    })
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
    const hang = ((_: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;
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

  test("OctoPos counts per attempt and its typed unavailable once", async () => {
    const result = await fetchOctoPosPortfolio("GADDR", {
      baseUrl: BASE,
      fetch: respondWith(400),
    });
    expect(result.ok).toBe(false);
    expect(counts()).toEqual({ "mainnet/defi/requests": 1, "mainnet/defi/unavailable": 1 });
  });

  test("the explorer wrapper counts a 429", async () => {
    await countedFetch("explorer", "mainnet", respondWith(429))("https://x.test");
    expect(counts()).toEqual({
      "mainnet/explorer/requests": 1,
      "mainnet/explorer/rate_limited": 1,
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

describe("rpc", () => {
  function rpcFailing(error: unknown): rpc.Server {
    return countedRpcServer("testnet", {
      getHealth: () => Promise.reject(error),
    } as unknown as rpc.Server);
  }

  test.each([
    [{ response: { status: 429 } }, "rate_limited"],
    [{ response: { status: 502 } }, "server_errors"],
    [new Error("timeout of 3000ms exceeded"), "timeouts"],
    [new Error("socket hang up"), "unavailable"],
  ])("failure %#: %p counts as its class", async (error, metric) => {
    await rpcFailing(error)
      .getHealth()
      .catch(() => undefined);
    await Promise.resolve();
    expect(counts()).toEqual({
      "testnet/rpc/requests": 1,
      [`testnet/rpc/${metric}`]: 1,
    });
  });

  test("a JSON-RPC error is an answer, not a failure class", async () => {
    await rpcFailing({ code: -32602, message: "invalid params" })
      .getHealth()
      .catch(() => undefined);
    await Promise.resolve();
    expect(counts()).toEqual({ "testnet/rpc/requests": 1 });
  });

  test("a send is counted, called once, and rejects with the original error", async () => {
    const boom = new Error("rpc down");
    const send = spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(boom);
    try {
      await expect(getRpcServer("testnet").sendTransaction({} as never)).rejects.toBe(boom);
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1);
      expect(counts()["testnet/rpc/requests"]).toBe(1);
    } finally {
      send.mockRestore();
    }
  });
});

describe("calls per request", () => {
  test("a representative account read makes exactly these calls", async () => {
    const address = Keypair.random().publicKey();
    const fetch = (async (input: string | URL | Request) => {
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
    }) as unknown as typeof globalThis.fetch;

    const tally = await inRequest(async () => {
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
    const finish: Array<() => void> = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      json() {},
      on: (_: string, f: () => void) => finish.push(f),
    };
    const logged: unknown[] = [];
    const spy = spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
      logged.push(line);
    });
    try {
      requestContextMiddleware()({ path: "/x" } as never, res as never, () => {
        recordUpstream("testnet", "rpc", "requests");
        recordUpstream("testnet", "rpc", "requests");
        recordUpstream("testnet", "horizon", "requests");
        recordUpstream("testnet", "horizon", "rate_limited");
      });
      finish.forEach((f) => f());
      expect(logged[0]).toMatchObject({ upstreamCalls: { rpc: 2, horizon: 1 } });

      requestContextMiddleware()({ path: "/x" } as never, res as never, () => undefined);
      finish.slice(1).forEach((f) => f());
      expect(logged[1]).not.toHaveProperty("upstreamCalls");
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
    const store = new FirestoreUsageStore({ collection } as never);
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
      const flushes = { count: 0 };
      const metrics = {
        flushIfDue: async () => {
          flushes.count++;
        },
      } as unknown as UpstreamMetricsService;
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ path }) }),
      } as unknown as ExecutionContext;
      const result = firstValueFrom(
        new UpstreamFlushInterceptor(metrics).intercept(context, { handle })
      );
      return { flushes, result };
    }

    test("flushes after a success", async () => {
      const { flushes, result } = run("/v1/testnet/analyze", () => of({ ok: true }));
      expect(await result).toEqual({ ok: true });
      expect(flushes.count).toBe(1);
    });

    test("flushes after a failure and still surfaces it", async () => {
      const boom = new Error("boom");
      const { flushes, result } = run("/v1/testnet/analyze", () => throwError(() => boom));
      await expect(result).rejects.toBe(boom);
      expect(flushes.count).toBe(1);
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
