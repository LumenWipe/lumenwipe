import { ApiRequestError } from "@/lib/utils/user-error";

/** The longest wait honored before the one automatic retry: the API's own `Retry-After` for a
 *  busy data provider, inside the 70 s it keeps that provider out of rotation. */
export const BUSY_RETRY_MAX_WAIT_SECONDS = 30;

/** The wait when a busy answer names none the page can read. */
export const BUSY_RETRY_DEFAULT_WAIT_SECONDS = 5;

export interface BusyRetryOptions {
  /** Ends the wait because the page was left or the request replaced. */
  signal?: AbortSignal;
  /** Ends the wait because the user stopped it. */
  stop?: AbortSignal;
  /** Told the seconds the page waits before it asks again, then null once the wait is over. */
  onWait?: (seconds: number | null) => void;
  sleep?: (ms: number, signals: readonly (AbortSignal | undefined)[]) => Promise<void>;
}

/** What a page lends the calls it starts: the user's stop, and a reporter per call for its wait. */
export interface BusyWaitHooks {
  stop?: AbortSignal;
  reporter?: () => (seconds: number | null) => void;
}

function isBusy(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 503;
}

/** The seconds to wait before asking again after a busy answer. */
export function busyWaitSeconds(err: ApiRequestError): number {
  return Math.min(
    err.retryAfterSeconds ?? BUSY_RETRY_DEFAULT_WAIT_SECONDS,
    BUSY_RETRY_MAX_WAIT_SECONDS
  );
}

function sleep(ms: number, signals: readonly (AbortSignal | undefined)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const live = signals.filter((s): s is AbortSignal => s !== undefined);
    if (live.some((s) => s.aborted)) return reject(new Error("aborted"));
    const done = (): void => {
      clearTimeout(timer);
      for (const s of live) s.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    for (const s of live) s.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs a read-only call, and after a 503 waits the `Retry-After` it gave, capped, then runs it
 * once more. Only for calls that change nothing: a second busy answer, or a wait that is stopped
 * or abandoned, rejects with the busy answer that started the wait.
 */
export async function retryOnceWhenBusy<T>(
  call: () => Promise<T>,
  opts: BusyRetryOptions = {}
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isBusy(err) || opts.signal?.aborted || opts.stop?.aborted) throw err;
    opts.onWait?.(busyWaitSeconds(err));
    try {
      await (opts.sleep ?? sleep)(busyWaitSeconds(err) * 1000, [opts.signal, opts.stop]);
    } catch {
      throw err;
    } finally {
      opts.onWait?.(null);
    }
    try {
      return await call();
    } catch (again) {
      throw opts.signal?.aborted ? err : again;
    }
  }
}
