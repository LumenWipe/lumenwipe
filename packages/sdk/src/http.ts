import { LumenWipeAbortError, LumenWipeApiError, LumenWipeTimeoutError } from "./errors";
import type { FetchLike, RequestOptions, RetryOptions } from "./options";
import { SDK_VERSION } from "./version";

/**
 * `transient`: a GET, safe to repeat after a network error, 429, 502, 503 or 504.
 * `throttle`: a stateless POST, repeated only after a 429 or 503 (the API refused before acting).
 * `never`: a request with a side effect; a failure is surfaced, never repeated.
 */
export type RetryPolicy = "transient" | "throttle" | "never";

export interface TransportRequest extends RequestOptions {
  retry: RetryPolicy;
}

const MAX_DELAY_MS = 30_000;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const THROTTLE_STATUSES = new Set([429, 503]);

/**
 * Low-level transport: sends `Authorization: Bearer <key>`, applies the request
 * timeout, and turns responses into typed results or errors. Kept separate from
 * the endpoint-facing client so the HTTP concerns live in one place.
 */
export class HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeout: number,
    private readonly doFetch: FetchLike,
    private readonly retry?: RetryOptions
  ) {}

  async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: TransportRequest
  ): Promise<T> {
    const attempts =
      opts.retry === "never" ? 1 : Math.max(1, Math.floor(this.retry?.attempts ?? 1));
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, body, opts.signal);
      } catch (e) {
        if (attempt >= attempts || !this.shouldRetry(opts.retry, e)) throw e;
        await this.sleep(this.delayMs(e, attempt), opts.signal);
      }
    }
  }

  private shouldRetry(policy: RetryPolicy, e: unknown): boolean {
    if (e instanceof LumenWipeApiError) {
      const statuses = policy === "transient" ? TRANSIENT_STATUSES : THROTTLE_STATUSES;
      return statuses.has(e.status);
    }
    return (
      policy === "transient" &&
      !(e instanceof LumenWipeTimeoutError) &&
      !(e instanceof LumenWipeAbortError)
    );
  }

  private delayMs(e: unknown, attempt: number): number {
    if (e instanceof LumenWipeApiError && e.retryAfterMs !== undefined) {
      return Math.min(e.retryAfterMs, MAX_DELAY_MS);
    }
    const base = this.retry?.baseDelayMs ?? 0;
    return Math.min(base * 2 ** (attempt - 1) * (0.5 + Math.random() / 2), MAX_DELAY_MS);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new LumenWipeAbortError(signal.reason));
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new LumenWipeAbortError(signal?.reason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async once<T>(
    method: string,
    path: string,
    body: unknown,
    callerSignal?: AbortSignal
  ): Promise<T> {
    if (callerSignal?.aborted) throw new LumenWipeAbortError(callerSignal.reason);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-LumenWipe-SDK": `sdk/${SDK_VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const bounded = Number.isFinite(this.timeout) && this.timeout > 0;
    const timer = bounded
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeout)
      : undefined;

    try {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        // A proxy/CDN can return a non-JSON error body (e.g. an HTML 502). Fall
        // back to the raw text so a non-2xx always surfaces as a LumenWipeApiError
        // with its status, never a raw SyntaxError.
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) throw new LumenWipeApiError(res.status, parsed, res.headers);
      return parsed as T;
    } catch (e) {
      if (callerAborted) throw new LumenWipeAbortError(callerSignal?.reason);
      if (timedOut) throw new LumenWipeTimeoutError(this.timeout);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
