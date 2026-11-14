import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  measuredRange,
  rangeFor,
  resolvePlan,
  STANDARD_SELECTION,
  unitCounts,
  type MeasuredDurations,
} from "@/lib/scenarios";
import { MEASURED_DURATIONS } from "@/lib/scenarios/measured-durations";
import {
  JSON_REPORT_PATH,
  MIN_SAMPLES,
  moduleSource,
  percentile,
  summarize,
  TIMINGS_ATTACHMENT,
  type PlaywrightReport,
  type TimingSample,
} from "../../scripts/durations-report";

// The picker's duration range: measured per unit from nightly reports by scripts/durations.ts,
// scaled by a selection's own counts, and absent (the constant estimate stays) until measured.

const MEASURED: MeasuredDurations = {
  measuredAt: "2026-11-15",
  runs: ["43600000001"],
  units: {
    setup: { samples: 10, low: 4, high: 6 },
    classicStep: { samples: 40, low: 2, high: 3 },
    sorobanStep: { samples: 10, low: 8, high: 12 },
    closeRound: { samples: 20, low: 5, high: 9 },
  },
  coverage: { inside: 8, tests: 10 },
};

describe("the measured range", () => {
  test("is absent while nothing has been measured, so the picker keeps the estimate", () => {
    expect(measuredRange(resolvePlan(STANDARD_SELECTION).cost, null)).toBeNull();
  });

  test("the recorded measurements meet the script's own floor and cover the standard run", () => {
    expect(MEASURED_DURATIONS).not.toBeNull();
    for (const unit of Object.values(MEASURED_DURATIONS!.units)) {
      expect(unit.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(unit.low).toBeLessThanOrEqual(unit.high);
    }
    expect(measuredRange(resolvePlan(STANDARD_SELECTION).cost)).not.toBeNull();
  });

  test("scales each unit's range by the run's own counts, setup included", () => {
    const cost = resolvePlan(STANDARD_SELECTION).cost;
    const counts = unitCounts(cost);
    expect(counts.setup).toBe(1);
    expect(counts.classicStep).toBe(cost.classicTransactions - 1);
    expect(counts.closeRound).toBe(cost.closeGroups + cost.sorobanExits);
    const range = measuredRange(cost, MEASURED);
    expect(range).toEqual({
      low: 4 + counts.classicStep * 2 + counts.sorobanStep * 8 + counts.closeRound * 5,
      high: 6 + counts.classicStep * 3 + counts.sorobanStep * 12 + counts.closeRound * 9,
      measuredAt: "2026-11-15",
      runs: 1,
    });
  });

  test("is absent when a unit the run needs has no samples, never a guess", () => {
    const unmeasured = {
      ...MEASURED,
      units: { ...MEASURED.units, sorobanStep: { samples: 0, low: 0, high: 0 } },
    };
    expect(
      rangeFor({ setup: 1, classicStep: 2, sorobanStep: 0, closeRound: 1 }, unmeasured)
    ).toEqual({ low: 4 + 4 + 5, high: 6 + 6 + 9 });
    expect(
      rangeFor({ setup: 1, classicStep: 2, sorobanStep: 1, closeRound: 1 }, unmeasured)
    ).toBeNull();
  });
});

function attach(samples: TimingSample[]) {
  return {
    name: TIMINGS_ATTACHMENT,
    body: Buffer.from(JSON.stringify(samples)).toString("base64"),
  };
}

/** A passed test's requests: a session, its setup, two classic steps, a contract call, a round. */
function run(i: number): TimingSample[] {
  return [
    { route: "session", kind: null, ms: 1000 },
    { route: "mess", kind: "setup", ms: 1000 + i * 100 },
    { route: "mess", kind: "change_trust", ms: 2000 + i * 200 },
    { route: "mess", kind: "manage_data", ms: 2000 + i * 200 },
    { route: "mess", kind: "blend_submit", ms: 8000 + i * 400 },
    { route: "close", kind: null, ms: 5000 + i * 500 },
  ];
}

function report(results: { status: string; samples: TimingSample[] }[]): PlaywrightReport {
  return {
    stats: { startTime: "2026-11-15T07:00:12.000Z" },
    suites: [
      {
        suites: [
          {
            specs: results.map((r) => ({
              tests: [{ results: [{ status: r.status, attachments: [attach(r.samples)] }] }],
            })),
          },
        ],
      },
    ],
  };
}

describe("scripts/durations.ts", () => {
  const passed = Array.from({ length: 10 }, (_, i) => ({ status: "passed", samples: run(i) }));

  test("takes the 10th and 90th percentiles of passed tests only", () => {
    const failed = { status: "failed", samples: run(100) };
    const measured = summarize([{ run: "43600000001", report: report([...passed, failed]) }]);
    expect(measured.measuredAt).toBe("2026-11-15");
    expect(measured.runs).toEqual(["43600000001"]);
    expect(measured.units.setup).toEqual({ samples: 10, low: 2, high: 2.8 });
    expect(measured.units.classicStep).toEqual({ samples: 20, low: 2, high: 3.6 });
    expect(measured.units.sorobanStep).toEqual({ samples: 10, low: 8, high: 11.2 });
    expect(measured.units.closeRound).toEqual({ samples: 10, low: 5, high: 9 });
    expect(measured.coverage.tests).toBe(10);
    expect(measured.coverage.inside).toBeGreaterThan(0);
    expect(measured.coverage.inside).toBeLessThanOrEqual(10);
  });

  test("writes nothing when a unit has too few samples", () => {
    const few = passed.slice(0, MIN_SAMPLES - 1);
    expect(() => summarize([{ run: "43600000001", report: report(few) }])).toThrow(/samples/);
  });

  test("skips a test with no single session, such as a batch", () => {
    const batchRun = { status: "passed", samples: run(1).filter((s) => s.route !== "session") };
    const measured = summarize([{ run: "43600000001", report: report([...passed, batchRun]) }]);
    expect(measured.units.setup.samples).toBe(10);
  });

  test("percentiles are nearest rank", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.1)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  test("writes a module the estimator reads back", () => {
    const measured = summarize([{ run: "43600000001", report: report(passed) }]);
    const source = moduleSource(measured);
    expect(source).toContain("export const MEASURED_DURATIONS: MeasuredDurations | null = ");
    const literal = source.slice(source.indexOf("= ") + 2, source.lastIndexOf(";"));
    expect(JSON.parse(literal)).toEqual(measured);
  });
});

test("the nightly uploads the directory the JSON report is written to", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", ".github", "workflows", "e2e-nightly.yml"),
    "utf8"
  );
  const directory = JSON_REPORT_PATH.slice(0, JSON_REPORT_PATH.lastIndexOf("/") + 1);
  expect(workflow).toContain(`apps/playground/${directory}`);
  const config = readFileSync(join(import.meta.dir, "..", "..", "playwright.config.ts"), "utf8");
  expect(config).toContain("outputFile: JSON_REPORT_PATH");
});
