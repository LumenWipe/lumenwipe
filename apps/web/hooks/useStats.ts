"use client";

import { useEffect, useState } from "react";
import { STATS_REFRESH_EVENT } from "@/lib/stats-events";

export interface Stats {
  testnet: number;
  mainnet: number;
  testnetXlmStroops: string;
  mainnetXlmStroops: string;
}

export interface UseStatsResult {
  /** Last successfully fetched stats; null until the first success. */
  stats: Stats | null;
  /** True while the most recent fetch failed - `stats` may be stale. */
  stale: boolean;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Polls /api/stats and refreshes immediately when a merge recorded in this
 * session dispatches STATS_REFRESH_EVENT. On failure the previous values are
 * kept and `stale` flips to true so the UI can say so instead of hiding it.
 */
export function useStats(): UseStatsResult {
  const [stats, setStats] = useState<Stats | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error(`stats request returned ${res.status}`);
        const data: Stats = await res.json();
        if (active) {
          setStats(data);
          setStale(false);
        }
      } catch (err) {
        console.error("Failed to load stats:", err);
        if (active) setStale(true);
      }
    }

    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    window.addEventListener(STATS_REFRESH_EVENT, load);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener(STATS_REFRESH_EVENT, load);
    };
  }, []);

  return { stats, stale };
}
