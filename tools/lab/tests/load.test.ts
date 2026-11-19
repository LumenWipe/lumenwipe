import { describe, expect, test } from "bun:test";
import { LabRefusal } from "../src/home";
import {
  LOAD_SCENARIOS,
  assertLoadTarget,
  loadScenarios,
  renderLoadReport,
  runLoad,
  type LoadOptions,
} from "../src/load";
import { LIMITS, refusalSustained, verdict, type Sample, type StageSummary } from "../src/ramp";
import { assertNoSecrets } from "../src/report";

const KEY = `lab_${"K".repeat(32)}`;
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.test-only.signature";

describe("target", () => {
  test.each([
    "https://lumenwipe-api-loadtest-abc123xyz-uc.a.run.app",
    "https://lumenwipe-api-loadtest-631436303284.us-central1.run.app",
    "https://lumenwipe-api-loadtest-631436303284.us-central1.run.app/",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ])("accepts %s", (url) => {
    expect(assertLoadTarget(url).hostname).toBeTruthy();
  });

  test.each([
    ["the production domain", "https://api.lumenwipe.com"],
    ["the production service", "https://lumenwipe-api-abc123xyz-uc.a.run.app"],
    [
      "a revision tag on production",
      "https://lumenwipe-api-loadtest---lumenwipe-api-abc-uc.a.run.app",
    ],
    ["a candidate tag", "https://candidate---lumenwipe-api-abc123xyz-uc.a.run.app"],
    ["plain http to Cloud Run", "http://lumenwipe-api-loadtest-abc123xyz-uc.a.run.app"],
    ["a look-alike host", "https://lumenwipe-api-loadtest-x.a.run.app.example.com"],
    ["a path", "https://lumenwipe-api-loadtest-abc-uc.a.run.app/v1/mainnet"],
    ["a query", "http://127.0.0.1:3000/?network=mainnet"],
    ["credentials", "https://user:pass@lumenwipe-api-loadtest-abc-uc.a.run.app"],
    ["no URL", undefined],
    ["not a URL", "lumenwipe-api-loadtest"],
  ])("refuses %s", (_, url) => {
    expect(() => assertLoadTarget(url)).toThrow(LabRefusal);
  });
});

describe("scenarios", () => {
  test("read testnet only, and never build transactions", () => {
    const scenarios = loadScenarios();
    expect(scenarios.map((s) => s.id).sort()).toEqual([...LOAD_SCENARIOS].sort());
    for (const s of scenarios) {
      expect(s.network).toBe("testnet");
      expect(s.path).not.toContain("mainnet");
      expect(s.path).not.toContain("/transactions");
    }
  });
});

const sample = (end: number, status: number): Sample => ({
  stage: 1,
  scenario: "plan",
  start: end - 100,
  end,
  status,
});

describe("stop rule", () => {
  const W = LIMITS.windowMs;

  test("two consecutive windows at 5 percent refused or more are sustained", () => {
    const samples = [
      ...Array.from({ length: 19 }, (_, i) => sample(i * 100, 200)),
      sample(1_000, 503),
      ...Array.from({ length: 19 }, (_, i) => sample(W + i * 100, 200)),
      sample(W + 5_000, 503),
    ];
    expect(refusalSustained(samples, 0, 2 * W, LIMITS)).toBe(true);
  });

  test("one refusing window, a window under the share, or the window still filling is not", () => {
    const one = [sample(100, 503), sample(W + 100, 200)];
    expect(refusalSustained(one, 0, 2 * W, LIMITS)).toBe(false);
    const under = [
      sample(100, 503),
      ...Array.from({ length: 21 }, (_, i) => sample(W + i * 100, 200)),
      sample(W + 5_000, 503),
    ];
    expect(refusalSustained(under, 0, 2 * W, LIMITS)).toBe(false);
    const filling = [sample(100, 503), sample(W + 100, 503)];
    expect(refusalSustained(filling, 0, W + 200, LIMITS)).toBe(false);
  });

  test("an empty window between two refusing ones breaks the run", () => {
    const gap = [sample(100, 503), sample(2 * W + 100, 503)];
    expect(refusalSustained(gap, 0, 3 * W, LIMITS)).toBe(false);
  });
});

const stage = (concurrency: number, p95: number | null): StageSummary => ({
  concurrency,
  requests: 10,
  ok: 10,
  refused: 0,
  statuses: { 200: 10 },
  p50: p95,
  p95,
  durationMs: 1000,
  throughput: 10,
});

describe("verdict", () => {
  test("records where p95 first reaches twice the one-in-flight p95", () => {
    const v = verdict([stage(1, 500), stage(2, 600), stage(4, 999), stage(8, 1000)], null);
    expect(v).toEqual({ baselineP95: 500, p95DoubledAt: 8, highestHealthy: 4 });
  });

  test("the stage a sustained refusal stopped is never healthy", () => {
    const v = verdict([stage(1, 500), stage(2, 600), stage(4, 700)], 4);
    expect(v).toEqual({ baselineP95: 500, p95DoubledAt: null, highestHealthy: 2 });
  });
});

/** A fake API answering instantly, on a clock that moves `stepMs` per request. */
function fakeApi(status: (n: number) => number, stepMs = 10) {
  let clock = 0;
  let n = 0;
  const seen: { url: string; headers: Headers; method: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    clock += stepMs;
    return new Response("{}", { status: status(++n) });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl, now: () => clock };
}

const base = (api: ReturnType<typeof fakeApi>): LoadOptions => ({
  baseUrl: "http://127.0.0.1:1",
  apiKey: KEY,
  idToken: TOKEN,
  fetchImpl: api.fetchImpl,
  now: api.now,
});

describe("runLoad", () => {
  test("ramps through every stage, each within its request cap, under the total cap", async () => {
    const api = fakeApi(() => 200);
    const r = await runLoad(base(api));
    expect(r.stopped).toBe("ramp_complete");
    expect(r.stages.map((s) => s.concurrency)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(r.stages.every((s) => s.requests === LIMITS.stageRequests)).toBe(true);
    expect(r.totalRequests).toBeLessThanOrEqual(LIMITS.totalRequests);
  });

  test("the total request cap ends the run mid-stage", async () => {
    const api = fakeApi(() => 200);
    const r = await runLoad({ ...base(api), limits: { ...LIMITS, totalRequests: 250 } });
    expect(r).toMatchObject({ stopped: "request_cap", stoppedAt: 2, totalRequests: 250 });
  });

  test("sends the API key and Cloud Run's token apart, reading testnet only", async () => {
    const api = fakeApi(() => 200);
    await runLoad({ ...base(api), stages: [1] });
    for (const { url, headers, method } of api.seen) {
      expect(headers.get("Authorization")).toBe(`Bearer ${KEY}`);
      expect(headers.get("X-Serverless-Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(url).toContain("/v1/testnet/");
      expect(url).not.toContain("/transactions");
      expect(["GET", "POST"]).toContain(method);
    }
  });

  test("stops at a sustained upstream refusal and records the stage", async () => {
    // From the 50th request on, every answer is a 503; 1 s per request fills each 10 s window.
    const api = fakeApi((n) => (n >= 50 ? 503 : 200), 1_000);
    const r = await runLoad({ ...base(api), limits: { ...LIMITS, stageMs: 1e9, totalMs: 1e9 } });
    expect(r.stopped).toBe("upstream_refusal");
    expect(r.stoppedAt).toBe(1);
    expect(r.totalRequests).toBeLessThan(80);
  });

  test("the time cap ends the run whatever the ramp has left", async () => {
    const api = fakeApi(() => 200, 1_000);
    const r = await runLoad({ ...base(api), limits: { ...LIMITS, totalMs: 30_000 } });
    expect(r.stopped).toBe("time_cap");
    expect(r.totalRequests).toBe(30);
  });

  test.each([
    [429, "api_rate_limit"],
    [404, "fixture_missing"],
  ])("a %d stops the run at once as %s", async (status, reason) => {
    const api = fakeApi((n) => (n === 3 ? status : 200));
    const r = await runLoad(base(api));
    expect(r.stopped).toBe(reason as "api_rate_limit");
    expect(r.totalRequests).toBe(3);
  });

  test("a request that never answers counts as no answer, not a success", async () => {
    let clock = 0;
    const fetchImpl = (async () => {
      clock += 10;
      throw new Error("timed out");
    }) as unknown as typeof fetch;
    const r = await runLoad({
      ...base(fakeApi(() => 200)),
      fetchImpl,
      now: () => clock,
      stages: [1],
    });
    expect(r.stages[0]).toMatchObject({ ok: 0, statuses: { 0: LIMITS.stageRequests } });
  });

  test("the report carries neither the key nor the token, and passes the secret check", async () => {
    const api = fakeApi((n) => (n % 7 === 0 ? 503 : 200));
    const r = await runLoad({ ...base(api), stages: [1, 2] });
    const text = renderLoadReport({ target: "127.0.0.1:1" }, r);
    expect(() => assertNoSecrets(text, [KEY, TOKEN])).not.toThrow();
    expect(() => assertNoSecrets(JSON.stringify(r), [KEY, TOKEN])).not.toThrow();
    expect(text).toContain("| 1 | 200 |");
    expect(text).toContain("Stopped by the end of the ramp, after 400 requests.");
  });
});
