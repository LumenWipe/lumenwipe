import {
  DURATION_UNITS,
  isSorobanStep,
  rangeFor,
  type DurationUnit,
  type MeasuredDurations,
  type UnitCounts,
} from "../lib/scenarios/durations";

/** What tests/e2e/timed.ts attaches to a test as `timings`: one entry per finished request. */
export interface TimingSample {
  route: "session" | "mess" | "close";
  /** A mess step's action kind; null for the other routes. */
  kind: string | null;
  ms: number;
}

export const TIMINGS_ATTACHMENT = "timings";

/** Where the nightly's Playwright JSON report is written, relative to apps/playground, inside the
 *  test-results directory the nightly uploads as `playground-playwright-report`. */
export const JSON_REPORT_PATH = "test-results/report.json";

/** Fewer samples than this for any unit and the script writes nothing. */
export const MIN_SAMPLES = 5;

interface ReportResult {
  status?: string;
  attachments?: { name?: string; body?: string }[];
}

interface ReportSuite {
  specs?: { tests?: { results?: ReportResult[] }[] }[];
  suites?: ReportSuite[];
}

/** The parts of a Playwright JSON report this reads. */
export interface PlaywrightReport {
  stats?: { startTime?: string };
  suites?: ReportSuite[];
}

function results(suites: ReportSuite[] = []): ReportResult[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).flatMap((t) => t.results ?? [])),
    ...results(suite.suites),
  ]);
}

function isSample(value: unknown): value is TimingSample {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.route === "session" || v.route === "mess" || v.route === "close") &&
    (v.kind === null || typeof v.kind === "string") &&
    typeof v.ms === "number" &&
    Number.isFinite(v.ms) &&
    v.ms >= 0
  );
}

/** One passed test's samples per unit, in seconds; null for a test without exactly one session. */
export function testSamples(samples: TimingSample[]): Record<DurationUnit, number[]> | null {
  const sessions = samples.filter((s) => s.route === "session");
  if (sessions.length !== 1) return null;
  const units: Record<DurationUnit, number[]> = {
    setup: [],
    classicStep: [],
    sorobanStep: [],
    closeRound: [],
  };
  let setup = sessions[0]!.ms;
  for (const sample of samples) {
    if (sample.route === "close") units.closeRound.push(sample.ms / 1000);
    if (sample.route !== "mess") continue;
    if (sample.kind === "setup") setup += sample.ms;
    else if (sample.kind && isSorobanStep(sample.kind)) units.sorobanStep.push(sample.ms / 1000);
    else units.classicStep.push(sample.ms / 1000);
  }
  units.setup.push(setup / 1000);
  return units;
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The measured table from one or more nightly reports, each with the run id it came from. */
export function summarize(reports: { run: string; report: PlaywrightReport }[]): MeasuredDurations {
  if (reports.length === 0) throw new Error("No report given");
  const tests: Record<DurationUnit, number[]>[] = [];
  for (const { report } of reports) {
    for (const result of results(report.suites)) {
      if (result.status !== "passed") continue;
      const attachment = result.attachments?.find((a) => a.name === TIMINGS_ATTACHMENT);
      if (!attachment?.body) continue;
      const parsed: unknown = JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
      if (!Array.isArray(parsed) || !parsed.every(isSample)) continue;
      const units = testSamples(parsed);
      if (units) tests.push(units);
    }
  }
  const pooled = (unit: DurationUnit): number[] => tests.flatMap((t) => t[unit]);
  const units = Object.fromEntries(
    DURATION_UNITS.map((unit) => {
      const values = pooled(unit);
      if (values.length < MIN_SAMPLES) {
        throw new Error(
          `Only ${values.length} samples for ${unit}; at least ${MIN_SAMPLES} needed`
        );
      }
      return [
        unit,
        {
          samples: values.length,
          low: round1(percentile(values, 0.1)),
          high: round1(percentile(values, 0.9)),
        },
      ];
    })
  ) as MeasuredDurations["units"];
  const dates = reports.map(({ report }) => report.stats?.startTime?.slice(0, 10));
  if (!dates.every((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    throw new Error("A report has no start time");
  }
  const measured: MeasuredDurations = {
    measuredAt: [...dates].sort()[0]!,
    runs: reports.map((r) => r.run),
    units,
    coverage: { inside: 0, tests: tests.length },
  };
  for (const test of tests) {
    const counts = Object.fromEntries(DURATION_UNITS.map((u) => [u, test[u].length])) as UnitCounts;
    const took = DURATION_UNITS.reduce((total, u) => total + test[u].reduce((a, b) => a + b, 0), 0);
    const range = rangeFor(counts, measured);
    if (range && took >= range.low && took <= range.high) measured.coverage.inside += 1;
  }
  return measured;
}

/** The measured-durations module the script writes. */
export function moduleSource(measured: MeasuredDurations): string {
  return [
    'import type { MeasuredDurations } from "./durations";',
    "",
    "// Written by scripts/durations.ts from nightly Playwright reports; never edited by hand.",
    `export const MEASURED_DURATIONS: MeasuredDurations | null = ${JSON.stringify(measured)};`,
    "",
  ].join("\n");
}
