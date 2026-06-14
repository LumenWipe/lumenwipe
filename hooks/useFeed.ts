"use client";

import { useEffect, useState } from "react";
import { STATS_REFRESH_EVENT } from "@/lib/stats-events";
import type { MergeRecord, DailyActivity, StatsResult } from "@/lib/kv";

export type { MergeRecord, DailyActivity };

export interface FeedData {
  recent: MergeRecord[];
  daily: DailyActivity[];
  totals: StatsResult;
}

export interface UseFeedResult {
  feed: FeedData | null;
  stale: boolean;
}

const POLL_MS = 15_000;

export function useFeed(): UseFeedResult {
  const [feed, setFeed] = useState<FeedData | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/stats/feed");
        if (!res.ok) throw new Error(`feed returned ${res.status}`);
        const data: FeedData = await res.json();
        if (active) {
          setFeed(data);
          setStale(false);
        }
      } catch (err) {
        console.error("Failed to load stats feed:", err);
        if (active) setStale(true);
      }
    }

    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener(STATS_REFRESH_EVENT, load);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener(STATS_REFRESH_EVENT, load);
    };
  }, []);

  return { feed, stale };
}
