/** Nearest-rank percentile: always a value that was actually measured. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
}

export function summarize(values: readonly number[]): Summary {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

const measured = (v: number | null): v is number => v !== null;

/** Cold is the first request of each round; warm is every request after it. A request that
 *  failed is `null`: it is left out, and never moves a warm request into the cold slot. */
export function splitColdWarm(rounds: readonly (readonly (number | null)[])[]): {
  cold: Summary;
  warm: Summary;
} {
  return {
    cold: summarize(rounds.map((r) => r[0] ?? null).filter(measured)),
    warm: summarize(rounds.flatMap((r) => r.slice(1)).filter(measured)),
  };
}
