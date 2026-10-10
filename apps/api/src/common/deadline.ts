export interface Deadline {
  signal: AbortSignal;
  remainingMs(): number;
}

export function createDeadline(ms: number, now: () => number = Date.now): Deadline {
  const expiresAt = now() + ms;
  return {
    signal: AbortSignal.timeout(ms),
    remainingMs: () => Math.max(0, expiresAt - now()),
  };
}
