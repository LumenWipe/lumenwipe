export const STATS_REFRESH_EVENT = "lumenwipe:stats-refresh";

export function notifyStatsRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(STATS_REFRESH_EVENT));
  }
}
