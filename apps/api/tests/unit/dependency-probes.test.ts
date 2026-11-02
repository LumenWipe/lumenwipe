import { afterEach, expect, spyOn, test } from "bun:test";
import { rpc } from "@stellar/stellar-sdk";
import { Test } from "@nestjs/testing";
import { TerminusModule } from "@nestjs/terminus";
import {
  CORE_PROBE_TTL_MS,
  DependencyProbes,
  QUOTA_PROBE_TTL_MS,
  liveDependencyProbes,
  type DependencyProbe,
} from "@/health/dependency-probes";
import { HealthController } from "@/health/health.controller";
import {
  HORIZON_FALLBACKS,
  OCTOPOS_API_URL_MAINNET,
  PATH_ROUTING_API_URLS,
  RPC_URLS,
} from "@/config/networks";
import { drainUpstreamCounts } from "@/lib/stellar/upstream-metrics";

function probe(run: DependencyProbe["run"], ttlMs = 1000): DependencyProbe {
  return { upstream: "horizon", network: "testnet", ttlMs, run };
}

afterEach(() => {
  drainUpstreamCounts();
});

test("a row is cached for its TTL", async () => {
  let runs = 0;
  let now = 1000;
  const probes = new DependencyProbes(
    [
      probe(async () => {
        runs++;
        return [null];
      }),
    ],
    () => now
  );
  await probes.statuses();
  now += 999;
  await probes.statuses();
  expect(runs).toBe(1);
  now += 1;
  await probes.statuses();
  expect(runs).toBe(2);
});

test("concurrent readers share one probe", async () => {
  let runs = 0;
  const probes = new DependencyProbes([
    probe(async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [null];
    }),
  ]);
  const [a, b] = await Promise.all([probes.statuses(), probes.statuses()]);
  expect(runs).toBe(1);
  expect(a).toEqual(b);
});

test("rows are cached apart: one row's TTL does not hold back another", async () => {
  const runs = { short: 0, long: 0 };
  let now = 1000;
  const probes = new DependencyProbes(
    [
      probe(async () => {
        runs.short++;
        return [null];
      }, 10),
      probe(async () => {
        runs.long++;
        return [null];
      }, 100),
    ],
    () => now
  );
  await probes.statuses();
  now += 10;
  await probes.statuses();
  expect(runs).toEqual({ short: 2, long: 1 });
});

test.each([
  [[null], "up"],
  [[null, "timeout"], "degraded"],
  [["timeout", "unavailable"], "down"],
  [[], "unconfigured"],
] as const)("providers %j are %s", async (results, state) => {
  const [row] = await new DependencyProbes([probe(async () => [...results])]).statuses();
  expect(row?.state).toBe(state);
});

test("the last error and last success outlive a recovery and an outage", async () => {
  let result: "rate_limited" | null = null;
  let now = 1_700_000_000_000;
  const probes = new DependencyProbes([probe(async () => [result], 1)], () => now);
  const [up] = await probes.statuses();
  expect(up?.lastSuccessAt).toBe(new Date(now).toISOString());
  expect(up?.lastErrorClass).toBeNull();

  const successAt = up?.lastSuccessAt;
  result = "rate_limited";
  now += 5;
  const [down] = await probes.statuses();
  expect(down?.state).toBe("down");
  expect(down?.lastSuccessAt).toBe(successAt);
  expect(down?.lastErrorClass).toBe("rate_limited");

  result = null;
  now += 5;
  const [back] = await probes.statuses();
  expect(back?.state).toBe("up");
  expect(back?.lastErrorClass).toBe("rate_limited");
});

test("a probe that throws reports a fixed class, never its text", async () => {
  const secret = "https://key-in-subdomain.provider.example/abc123";
  const [row] = await new DependencyProbes([
    probe(() => Promise.reject(new Error(secret))),
  ]).statuses();
  expect(row).toMatchObject({ state: "down", lastErrorClass: "unavailable" });
  expect(JSON.stringify(row)).not.toContain("provider.example");
});

test("DeFi and path finding keep the longer TTL, and DeFi is one mainnet row", () => {
  const rows = liveDependencyProbes();
  for (const row of rows) {
    const quota = row.upstream === "defi" || row.upstream === "paths";
    expect(row.ttlMs).toBe(quota ? QUOTA_PROBE_TTL_MS : CORE_PROBE_TTL_MS);
  }
  expect(QUOTA_PROBE_TTL_MS).toBe(300_000);
  expect(CORE_PROBE_TTL_MS).toBe(60_000);
  expect(rows.filter((r) => r.upstream === "defi").map((r) => r.network)).toEqual(["mainnet"]);
});

test("the route exposes only the fixed fields, whatever the providers answered", async () => {
  const KEY = "aaaaaaaa";
  const url = `https://${KEY}.provider.example/${KEY}`;
  const realMain = PATH_ROUTING_API_URLS.mainnet;
  const realTest = PATH_ROUTING_API_URLS.testnet;
  const realFallbacks = HORIZON_FALLBACKS.mainnet;
  const realRpc = { ...RPC_URLS };
  const realFetch = globalThis.fetch;
  PATH_ROUTING_API_URLS.mainnet = url;
  PATH_ROUTING_API_URLS.testnet = url;
  HORIZON_FALLBACKS.mainnet = [{ url, headers: {} }];
  RPC_URLS.mainnet = url;
  RPC_URLS.testnet = url;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ detail: `failed at ${url}`, balance: "9.99" }), {
      status: 503,
    });
  }) as unknown as typeof globalThis.fetch;
  const health = spyOn(rpc.Server.prototype, "getHealth").mockRejectedValue(new Error(url));
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule.forRoot()],
      controllers: [HealthController],
    }).compile();
    const { dependencies } = await moduleRef.get(HealthController).dependencies();
    const body = JSON.stringify(dependencies);
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("provider.example");
    expect(body).not.toContain("9.99");
    expect(seen.length).toBeGreaterThan(0);
    const fields = new Set(dependencies.flatMap((d) => Object.keys(d)));
    expect([...fields].sort()).toEqual([
      "lastErrorClass",
      "lastSuccessAt",
      "latencyMs",
      "network",
      "state",
      "upstream",
    ]);
    for (const row of dependencies) {
      if (row.upstream === "defi" && OCTOPOS_API_URL_MAINNET === "") {
        expect(row.state).toBe("unconfigured");
      } else {
        expect(row.state).toBe("down");
      }
      if (row.lastErrorClass !== null) {
        expect(["rate_limited", "timeout", "unavailable", "bad_response"]).toContain(
          row.lastErrorClass
        );
      }
    }
    expect(
      dependencies.find((d) => d.upstream === "horizon" && d.network === "mainnet")
    ).toMatchObject({ state: "down", lastErrorClass: "unavailable" });
  } finally {
    health.mockRestore();
    globalThis.fetch = realFetch;
    PATH_ROUTING_API_URLS.mainnet = realMain;
    PATH_ROUTING_API_URLS.testnet = realTest;
    HORIZON_FALLBACKS.mainnet = realFallbacks;
    RPC_URLS.mainnet = realRpc.mainnet;
    RPC_URLS.testnet = realRpc.testnet;
  }
});
