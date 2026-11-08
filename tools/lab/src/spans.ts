export interface Span {
  label: string;
  start: number;
  end: number;
}

export interface Breakdown {
  /** Per upstream label: how many calls, and the summed time they were in flight. */
  upstreams: Record<string, { calls: number; ms: number }>;
  /** Wall time with at least one upstream call in flight. */
  upstreamMs: number;
  /** Request time with no upstream call in flight: the API's own work (plan or transaction
   *  build, decoding, serialising) plus waiting between calls. */
  ownMs: number;
}

export function parseSpans(text: string): Span[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Span);
}

/** Spans that started inside the request window. Requests run one at a time, so these are the
 *  calls that request made. */
export function spansWithin(spans: readonly Span[], start: number, end: number): Span[] {
  return spans.filter((s) => s.start >= start && s.start <= end);
}

function unionMs(spans: readonly Span[], start: number, end: number): number {
  const intervals = spans
    .map((s) => [Math.max(s.start, start), Math.min(s.end, end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [a, b] of intervals) {
    const from = Math.max(a, cursor);
    if (b > from) total += b - from;
    cursor = Math.max(cursor, b);
  }
  return total;
}

export function breakdown(spans: readonly Span[], start: number, end: number): Breakdown {
  const upstreams: Breakdown["upstreams"] = {};
  for (const s of spans) {
    const entry = (upstreams[s.label] ??= { calls: 0, ms: 0 });
    entry.calls += 1;
    entry.ms += s.end - s.start;
  }
  const upstreamMs = unionMs(spans, start, end);
  return { upstreams, upstreamMs, ownMs: Math.max(0, end - start - upstreamMs) };
}
