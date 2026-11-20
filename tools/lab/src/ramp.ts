import { percentile } from "./stats";

/** In-flight requests per stage. Each stage runs until its time or request limit. */
export const STAGES: readonly number[] = [1, 2, 4, 8, 16, 32, 64];

export interface RampLimits {
  stageMs: number;
  stageRequests: number;
  /** Hard caps over the whole run, so it cannot spend a provider's free tier. */
  totalRequests: number;
  totalMs: number;
  requestTimeoutMs: number;
  /** Refusals are judged per window of this length, by when each response arrived. */
  windowMs: number;
  /** A window refuses when at least this share of its responses are upstream refusals. */
  refusalShare: number;
  /** This many refusing windows in a row are a sustained refusal, and stop the run. */
  refusalWindows: number;
}

export const LIMITS: RampLimits = {
  stageMs: 60_000,
  stageRequests: 200,
  totalRequests: 1_500,
  totalMs: 10 * 60_000,
  requestTimeoutMs: 45_000,
  windowMs: 10_000,
  refusalShare: 0.05,
  refusalWindows: 2,
};

/** One response. `status` is 0 when nothing answered (a network error or the request timeout). */
export interface Sample {
  stage: number;
  scenario: string;
  start: number;
  end: number;
  status: number;
}

/** The API answers 503 when a provider refused it (an upstream 429) or failed; see
 *  docs/runbooks/provider-outage.mdx. */
export const isUpstreamRefusal = (s: Sample): boolean => s.status === 503;

const ok = (s: Sample): boolean => s.status >= 200 && s.status < 300;

/**
 * Whether `refusalWindows` consecutive completed windows each had at least `refusalShare` of
 * their responses refused upstream. A window with no response breaks the run of windows. The
 * window still filling at `now` is not judged.
 */
export function refusalSustained(
  samples: readonly Sample[],
  runStart: number,
  now: number,
  limits: Pick<RampLimits, "windowMs" | "refusalShare" | "refusalWindows">
): boolean {
  const current = Math.floor((now - runStart) / limits.windowMs);
  const windows = new Map<number, { all: number; refused: number }>();
  for (const s of samples) {
    const w = Math.floor((s.end - runStart) / limits.windowMs);
    const entry = windows.get(w) ?? { all: 0, refused: 0 };
    entry.all++;
    if (isUpstreamRefusal(s)) entry.refused++;
    windows.set(w, entry);
  }
  let run = 0;
  for (let w = 0; w < current; w++) {
    const entry = windows.get(w);
    const refusing = entry !== undefined && entry.refused / entry.all >= limits.refusalShare;
    run = refusing ? run + 1 : 0;
    if (run >= limits.refusalWindows) return true;
  }
  return false;
}

export interface StageSummary {
  concurrency: number;
  requests: number;
  ok: number;
  /** 503 answers: a provider refused or failed. */
  refused: number;
  statuses: Record<string, number>;
  /** Over successful responses only, in milliseconds. */
  p50: number | null;
  p95: number | null;
  durationMs: number;
  /** Successful responses per second. */
  throughput: number;
}

export function summarizeStage(
  concurrency: number,
  samples: readonly Sample[],
  durationMs: number
): StageSummary {
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  const latencies = samples.filter(ok).map((s) => Math.round(s.end - s.start));
  return {
    concurrency,
    requests: samples.length,
    ok: latencies.length,
    refused: samples.filter(isUpstreamRefusal).length,
    statuses,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    durationMs: Math.round(durationMs),
    throughput:
      durationMs > 0 ? Math.round((latencies.length / (durationMs / 1000)) * 100) / 100 : 0,
  };
}

export type StopReason =
  | "upstream_refusal"
  | "api_rate_limit"
  | "fixture_missing"
  | "request_cap"
  | "time_cap"
  | "ramp_complete";

export interface RampVerdict {
  /** The p95 of the first stage, one request at a time. */
  baselineP95: number | null;
  /** The first stage whose p95 is at least twice the baseline. */
  p95DoubledAt: number | null;
  /** The highest stage that finished below the doubling and without a sustained refusal. */
  highestHealthy: number | null;
}

export function verdict(stages: readonly StageSummary[], refusedAt: number | null): RampVerdict {
  const baselineP95 = stages[0]?.p95 ?? null;
  let p95DoubledAt: number | null = null;
  let highestHealthy: number | null = null;
  for (const stage of stages) {
    if (baselineP95 === null || stage.p95 === null) break;
    if (stage.p95 >= baselineP95 * 2) {
      p95DoubledAt = stage.concurrency;
      break;
    }
    if (refusedAt !== null && stage.concurrency >= refusedAt) break;
    highestHealthy = stage.concurrency;
  }
  return { baselineP95, p95DoubledAt, highestHealthy };
}
