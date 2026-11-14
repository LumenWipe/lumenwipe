import { MEASURED_DURATIONS } from "./measured-durations";
import type { ScenarioCost, StepAction } from "./types";

export const DURATION_UNITS = ["setup", "classicStep", "sorobanStep", "closeRound"] as const;

/**
 * What the nightly times: `setup` is the session creation and its SETUP step, a step is one mess
 * request, and a close round is one demolish round or allowance revoke request.
 */
export type DurationUnit = (typeof DURATION_UNITS)[number];

export interface UnitRange {
  samples: number;
  /** Seconds, the 10th and 90th percentiles of the samples. */
  low: number;
  high: number;
}

export interface MeasuredDurations {
  /** The day the measured runs started, YYYY-MM-DD. */
  measuredAt: string;
  /** The nightly runs the samples come from. */
  runs: string[];
  units: Record<DurationUnit, UnitRange>;
  /** Of the measured tests, how many took a time inside the range their own unit counts give. */
  coverage: { inside: number; tests: number };
}

const SOROBAN_STEP_KINDS: ReadonlySet<StepAction["kind"]> = new Set([
  "soroswap_deposit",
  "aquarius_deposit",
  "blend_submit",
  "phoenix_swap",
  "phoenix_provide",
  "phoenix_bond",
  "approve_allowance",
]);

/** A mess step sent as a contract call rather than a classic transaction. */
export function isSorobanStep(kind: string): boolean {
  return SOROBAN_STEP_KINDS.has(kind as StepAction["kind"]);
}

export type UnitCounts = Record<DurationUnit, number>;

/** How many of each measured unit a run of this cost takes; its setup is one classic transaction. */
export function unitCounts(cost: ScenarioCost): UnitCounts {
  return {
    setup: 1,
    classicStep: Math.max(0, cost.classicTransactions - 1),
    sorobanStep: cost.sorobanTransactions,
    closeRound: cost.closeGroups + cost.sorobanExits,
  };
}

/** The low and high seconds for these counts, or null when a needed unit has no samples. */
export function rangeFor(
  counts: UnitCounts,
  measured: MeasuredDurations
): { low: number; high: number } | null {
  let low = 0;
  let high = 0;
  for (const unit of DURATION_UNITS) {
    if (counts[unit] === 0) continue;
    const range = measured.units[unit];
    if (range.samples === 0) return null;
    low += counts[unit] * range.low;
    high += counts[unit] * range.high;
  }
  return { low: Math.round(low), high: Math.round(high) };
}

export interface MeasuredRange {
  low: number;
  high: number;
  measuredAt: string;
  runs: number;
}

/** The measured range for a run of this cost, or null while no measurement covers it. */
export function measuredRange(
  cost: ScenarioCost,
  measured: MeasuredDurations | null = MEASURED_DURATIONS
): MeasuredRange | null {
  if (!measured) return null;
  const range = rangeFor(unitCounts(cost), measured);
  if (!range) return null;
  return { ...range, measuredAt: measured.measuredAt, runs: measured.runs.length };
}
