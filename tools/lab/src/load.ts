import { LabRefusal } from "./home";
import {
  LIMITS,
  STAGES,
  refusalSustained,
  summarizeStage,
  verdict,
  type RampLimits,
  type RampVerdict,
  type Sample,
  type StageSummary,
  type StopReason,
} from "./ramp";
import { scenariosFor, type Scenario } from "./scenarios";

/** Only reads, and only testnet: no flag selects mainnet or a scenario that builds transactions. */
export const LOAD_SCENARIOS = ["analyze-baseline", "analyze-dense", "analyze-token", "plan"];

export function loadScenarios(): Scenario[] {
  return scenariosFor("testnet").filter((s) => LOAD_SCENARIOS.includes(s.id));
}

/** The separate load-test service's URL on Cloud Run, in either of its two forms. A revision tag
 *  (`<tag>---<service>`) is refused, so no tag on the production service can pass. */
const LOAD_TEST_HOST = /^lumenwipe-api-loadtest-[a-z0-9-]+\.(?:a|[a-z]+-[a-z]+\d+)\.run\.app$/;
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+)$/;

/**
 * The only targets: the `lumenwipe-api-loadtest` service, or an API on this machine. Production,
 * its custom domain, its revision tags and any other host are refused.
 */
export function assertLoadTarget(raw: string | undefined): URL {
  if (!raw) throw new LabRefusal("load needs --url: the lumenwipe-api-loadtest service's URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LabRefusal(`--url is not a URL: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new LabRefusal("--url must be the service's bare origin, with no path or query");
  }
  const remote =
    url.protocol === "https:" && LOAD_TEST_HOST.test(url.hostname) && !url.hostname.includes("---");
  const local = url.protocol === "http:" && LOCAL_HOST.test(url.hostname);
  if (!remote && !local) {
    throw new LabRefusal(
      `load runs only against the lumenwipe-api-loadtest Cloud Run service or a local API, not ${url.host}`
    );
  }
  return url;
}

export interface LoadOptions {
  baseUrl: string;
  apiKey: string;
  /** Cloud Run's own credential for a private service, sent apart from the API key. */
  idToken?: string;
  scenarios?: readonly Scenario[];
  stages?: readonly number[];
  limits?: RampLimits;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LoadResult {
  stopped: StopReason;
  /** The stage the run stopped in, when it stopped early. */
  stoppedAt: number | null;
  stages: StageSummary[];
  verdict: RampVerdict;
  totalRequests: number;
}

const epochNow = (): number => performance.timeOrigin + performance.now();

export async function runLoad(opts: LoadOptions): Promise<LoadResult> {
  const scenarios = opts.scenarios ?? loadScenarios();
  const limits = opts.limits ?? LIMITS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? epochNow;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}` };
  if (opts.idToken) headers["X-Serverless-Authorization"] = `Bearer ${opts.idToken}`;

  const runStart = now();
  const samples: Sample[] = [];
  const stages: StageSummary[] = [];
  let stopped: StopReason | null = null;
  let stoppedAt: number | null = null;
  let refusedAt: number | null = null;
  let sequence = 0;
  let totalIssued = 0;

  const send = async (stage: number, scenario: Scenario): Promise<Sample> => {
    const start = now();
    try {
      const res = await doFetch(`${opts.baseUrl}${scenario.path}`, {
        method: scenario.method,
        headers: scenario.body ? { ...headers, "Content-Type": "application/json" } : headers,
        body: scenario.body ? JSON.stringify(scenario.body) : undefined,
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
        // A redirect could carry both credentials to another host; the service never sends one.
        redirect: "error",
      });
      await res.arrayBuffer();
      return { stage, scenario: scenario.id, start, end: now(), status: res.status };
    } catch {
      return { stage, scenario: scenario.id, start, end: now(), status: 0 };
    }
  };

  const stop = (reason: StopReason, stage: number) => {
    if (stopped) return;
    stopped = reason;
    stoppedAt = stage;
  };

  for (const concurrency of opts.stages ?? STAGES) {
    const stageStart = now();
    const stageSamples: Sample[] = [];
    let issued = 0;
    const canSend = (): boolean => {
      if (stopped) return false;
      if (totalIssued >= limits.totalRequests) {
        stop("request_cap", concurrency);
        return false;
      }
      if (now() - runStart >= limits.totalMs) {
        stop("time_cap", concurrency);
        return false;
      }
      return issued < limits.stageRequests && now() - stageStart < limits.stageMs;
    };
    const worker = async () => {
      while (canSend()) {
        issued++;
        totalIssued++;
        const sample = await send(concurrency, scenarios[sequence++ % scenarios.length]);
        samples.push(sample);
        stageSamples.push(sample);
        if (sample.status === 429) stop("api_rate_limit", concurrency);
        if (sample.status === 404) stop("fixture_missing", concurrency);
        if (refusalSustained(samples, runStart, now(), limits)) {
          refusedAt ??= concurrency;
          stop("upstream_refusal", concurrency);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const summary = summarizeStage(concurrency, stageSamples, now() - stageStart);
    stages.push(summary);
    opts.log?.(
      `${concurrency} in flight: ${summary.requests} requests, p95 ${summary.p95 ?? "-"} ms, ${summary.refused} refused`
    );
    if (stopped) break;
  }

  return {
    stopped: stopped ?? "ramp_complete",
    stoppedAt,
    stages,
    verdict: verdict(stages, refusedAt),
    totalRequests: samples.length,
  };
}

const STOP_TEXT: Record<StopReason, string> = {
  upstream_refusal: "a sustained upstream refusal (503 from the API)",
  api_rate_limit:
    "a 429 from the API's own rate limit: raise THROTTLE_LIMIT on the load-test service",
  fixture_missing: "a fixture account that no longer exists on testnet",
  request_cap: "the request cap",
  time_cap: "the time cap",
  ramp_complete: "the end of the ramp",
};

export function renderLoadReport(meta: Record<string, string>, result: LoadResult): string {
  const v = result.verdict;
  const rows = [
    "| In flight | Requests | OK | Refused (503) | p50 | p95 | OK per second | Statuses |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.stages.map((s) => {
      const statuses = Object.entries(s.statuses)
        .map(([code, n]) => `${code === "0" ? "no answer" : code} x${n}`)
        .join(", ");
      return `| ${s.concurrency} | ${s.requests} | ${s.ok} | ${s.refused} | ${s.p50 ?? "-"} | ${s.p95 ?? "-"} | ${s.throughput} | ${statuses} |`;
    }),
  ];
  const at = result.stoppedAt === null ? "" : ` at ${result.stoppedAt} in flight`;
  return [
    "# LumenWipe API load ramp (testnet, read-only)",
    "",
    ...Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`),
    "",
    `Stopped by ${STOP_TEXT[result.stopped]}${at}, after ${result.totalRequests} requests.`,
    "",
    `- Baseline p95 (1 in flight): ${v.baselineP95 ?? "-"} ms`,
    `- p95 doubled at: ${v.p95DoubledAt ?? "not reached"}${v.p95DoubledAt === null ? "" : " in flight"}`,
    `- Highest stage below the doubling and without a sustained refusal: ${v.highestHealthy ?? "none"}`,
    "",
    "Times in milliseconds, over successful responses.",
    "",
    ...rows,
    "",
  ].join("\n");
}
