/**
 * Per-upstream, per-network counts of what the API asks of its providers.
 *
 * Recording is synchronous and in memory, so it adds no I/O to an upstream call. The buffer is
 * written to the durable store by `UpstreamMetricsService`.
 */

import { currentUpstreamCalls } from "@/common/request-context";
import type { Network } from "@/config/networks";

export type Upstream = "rpc" | "horizon" | "defi" | "explorer" | "paths";

export type UpstreamMetric =
  "requests" | "rate_limited" | "timeouts" | "server_errors" | "failovers" | "unavailable";

/** `unknown` is a read whose caller named no network, kept rather than dropped. */
export type MetricNetwork = Network | "unknown";

export interface UpstreamDelta {
  network: MetricNetwork;
  upstream: Upstream;
  metric: UpstreamMetric;
  count: number;
}

const pending = new Map<string, UpstreamDelta>();

function add(delta: UpstreamDelta): void {
  const key = `${delta.network}/${delta.upstream}/${delta.metric}`;
  const entry = pending.get(key);
  if (entry) entry.count += delta.count;
  else pending.set(key, { ...delta });
}

export function recordUpstream(
  network: MetricNetwork,
  upstream: Upstream,
  metric: UpstreamMetric
): void {
  add({ network, upstream, metric, count: 1 });
  if (metric !== "requests") return;
  const calls = currentUpstreamCalls();
  calls?.set(upstream, (calls.get(upstream) ?? 0) + 1);
}

/** Empties the buffer: the caller owns the returned counts until they are written. */
export function drainUpstreamCounts(): UpstreamDelta[] {
  const deltas = [...pending.values()];
  pending.clear();
  return deltas;
}

export function restoreUpstreamCounts(deltas: readonly UpstreamDelta[]): void {
  deltas.forEach(add);
}

/** Wraps a fetch so every attempt is counted, whichever client or retry policy sits above it. */
export function countedFetch(
  upstream: Upstream,
  network: MetricNetwork,
  doFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  const counted = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    recordUpstream(network, upstream, "requests");
    try {
      const res = await doFetch(input, init);
      if (res.status === 429) recordUpstream(network, upstream, "rate_limited");
      else if (res.status >= 500) recordUpstream(network, upstream, "server_errors");
      return res;
    } catch (error) {
      if (init?.signal?.aborted) recordUpstream(network, upstream, "timeouts");
      throw error;
    }
  };
  return counted as typeof globalThis.fetch;
}
