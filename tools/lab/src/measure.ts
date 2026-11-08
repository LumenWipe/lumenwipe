import type { Network, Scenario } from "./scenarios";
import { breakdown, spansWithin, type Breakdown, type Span } from "./spans";
import { percentile, splitColdWarm, summarize, type Summary } from "./stats";

export type TargetKind = "production" | "local";

/** One API to measure. A local target starts a fresh process per round, so its first request
 *  is cold in the process sense; a production target cannot choose its instance. */
export interface TargetSession {
  baseUrl: string;
  apiKey: string;
  bootMs?: number;
  spans?: () => Span[];
  stop(): Promise<void>;
}

export interface MeasureOptions {
  target: TargetKind;
  scenarios: readonly Scenario[];
  /** Requests per round, 5 to 11. */
  runs: number;
  rounds: number;
  open: () => Promise<TargetSession>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pause?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface SpanSummary {
  upstreams: Record<string, { calls: number; ms: number }>;
  upstreamMs: number;
  ownMs: number;
}

export interface ScenarioResult {
  target: TargetKind;
  network: Network;
  scenario: string;
  what: string;
  rounds: number;
  runs: number;
  missing: boolean;
  statuses: Record<string, number>;
  cold: Summary;
  warm: Summary;
  boot?: Summary;
  /** Medians over the warm requests (or the cold ones when there is no warm request). */
  spans?: SpanSummary;
}

export const MIN_RUNS = 5;
export const MAX_RUNS = 11;

const epochNow = (): number => performance.timeOrigin + performance.now();

function median(values: number[]): number {
  return percentile(values, 50) ?? 0;
}

function summarizeSpans(samples: Breakdown[]): SpanSummary {
  const labels = new Set(samples.flatMap((s) => Object.keys(s.upstreams)));
  const upstreams: SpanSummary["upstreams"] = {};
  for (const label of [...labels].sort()) {
    upstreams[label] = {
      calls: median(samples.map((s) => s.upstreams[label]?.calls ?? 0)),
      ms: Math.round(median(samples.map((s) => s.upstreams[label]?.ms ?? 0))),
    };
  }
  return {
    upstreams,
    upstreamMs: Math.round(median(samples.map((s) => s.upstreamMs))),
    ownMs: Math.round(median(samples.map((s) => s.ownMs))),
  };
}

async function timedRequest(
  session: TargetSession,
  scenario: Scenario,
  doFetch: typeof fetch,
  now: () => number
): Promise<{ status: number; start: number; end: number }> {
  const start = now();
  const res = await doFetch(`${session.baseUrl}${scenario.path}`, {
    method: scenario.method,
    headers: {
      Authorization: `Bearer ${session.apiKey}`,
      ...(scenario.body && { "Content-Type": "application/json" }),
    },
    body: scenario.body ? JSON.stringify(scenario.body) : undefined,
  });
  await res.arrayBuffer();
  return { status: res.status, start, end: now() };
}

export async function measure(opts: MeasureOptions): Promise<ScenarioResult[]> {
  if (!Number.isInteger(opts.runs) || opts.runs < MIN_RUNS || opts.runs > MAX_RUNS) {
    throw new RangeError(`runs must be an integer from ${MIN_RUNS} to ${MAX_RUNS}`);
  }
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
    throw new RangeError("rounds must be a positive integer");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? epochNow;
  const pause = opts.pause ?? (() => Bun.sleep(300));
  const results: ScenarioResult[] = [];

  for (const scenario of opts.scenarios) {
    const statuses: Record<string, number> = {};
    const roundLatencies: (number | null)[][] = [];
    const boots: number[] = [];
    const warmBreakdowns: Breakdown[] = [];
    const coldBreakdowns: Breakdown[] = [];
    let missing = false;

    for (let round = 0; round < opts.rounds && !missing; round++) {
      const session = await opts.open();
      try {
        if (session.bootMs !== undefined) boots.push(session.bootMs);
        const latencies: (number | null)[] = [];
        for (let i = 0; i < opts.runs; i++) {
          const { status, start, end } = await timedRequest(session, scenario, doFetch, now);
          statuses[status] = (statuses[status] ?? 0) + 1;
          if (status === 404 && scenario.fixture) {
            missing = true;
            break;
          }
          const ok = status >= 200 && status < 300;
          latencies.push(ok ? Math.round(end - start) : null);
          if (ok && session.spans) {
            const b = breakdown(spansWithin(session.spans(), start, end), start, end);
            (i === 0 ? coldBreakdowns : warmBreakdowns).push(b);
          }
          if (i < opts.runs - 1) await pause();
        }
        roundLatencies.push(latencies);
      } finally {
        await session.stop();
      }
    }

    const { cold, warm } = splitColdWarm(roundLatencies);
    const spanSamples = warmBreakdowns.length > 0 ? warmBreakdowns : coldBreakdowns;
    results.push({
      target: opts.target,
      network: scenario.network,
      scenario: scenario.id,
      what: scenario.what,
      rounds: opts.rounds,
      runs: opts.runs,
      missing,
      statuses,
      cold,
      warm,
      ...(boots.length > 0 && { boot: summarize(boots.map(Math.round)) }),
      ...(spanSamples.length > 0 && { spans: summarizeSpans(spanSamples) }),
    });
    opts.log?.(
      `${opts.target} ${scenario.network} ${scenario.id}: ${missing ? "fixture missing" : JSON.stringify(statuses)}`
    );
  }
  return results;
}
