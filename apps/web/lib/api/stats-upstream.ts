import "server-only";
import type { Network, StatsFeed, StatsTotals } from "@lumenwipe/types";

const TIMEOUT_MS = 8_000;

/**
 * Reads the API's public stats endpoints. No API key: they are `@Public()`, like the exchange
 * registry, so the shared key is never spent on them. Throws on any failure so the route
 * answers "unavailable" instead of serving zeros as if they were real counts.
 */
async function getPublic<T>(path: string, revalidate: number): Promise<T> {
  const base = process.env.LUMENWIPE_API_URL;
  if (!base) throw new Error("LUMENWIPE_API_URL is not configured.");
  const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    next: { revalidate },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export function fetchStatsTotals(network: Network, revalidate: number): Promise<StatsTotals> {
  return getPublic<StatsTotals>(`/v1/${network}/stats`, revalidate);
}

export function fetchStatsFeed(network: Network, revalidate: number): Promise<StatsFeed> {
  return getPublic<StatsFeed>(`/v1/${network}/stats/feed`, revalidate);
}
