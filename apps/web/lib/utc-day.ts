/**
 * The UTC day a rate-limit counter belongs to, as `YYYY-MM-DD`. The per-IP daily counter's key
 * ends in it, so the counter starts again at 00:00 UTC.
 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Seconds from `now` until the next 00:00 UTC, when `utcDayKey` changes and a caller over the
 * limit counts against a fresh key: between 1 and 86 400.
 */
export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
