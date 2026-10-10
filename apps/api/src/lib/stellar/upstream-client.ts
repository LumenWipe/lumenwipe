/**
 * The one outbound read client every upstream provider call goes through.
 *
 * A failed read is never an answer: it ends as a typed `UpstreamError`, so a caller can tell an
 * outage from an empty result. Reads are retried with jittered backoff inside the request's
 * deadline; nothing here retries a transaction submission, which is not a read.
 */

import { Logger } from "@nestjs/common";
import { HORIZON_TIMEOUT_MS, REQUEST_DEADLINE_MS } from "@/config/constants";
import { createDeadline, type Deadline } from "@/common/deadline";
import { currentDeadline } from "@/common/request-context";

export type UpstreamErrorKind = "rate_limited" | "timeout" | "unavailable" | "bad_response";

const MESSAGES: Record<UpstreamErrorKind, string> = {
  rate_limited: "The data provider is busy right now. Try again in a moment.",
  timeout: "The data provider took too long to answer. Try again in a moment.",
  unavailable: "The data provider is unavailable right now. Try again in a moment.",
  bad_response: "The data provider could not answer this request.",
};

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    readonly target: string,
    message: string = MESSAGES[kind]
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  maxRetryAfterMs: number;
  perAttemptMs: number;
}

export const DEFAULT_UPSTREAM_POLICY: UpstreamPolicy = {
  maxRetries: 3,
  baseBackoffMs: 400,
  maxRetryAfterMs: 5_000,
  perAttemptMs: HORIZON_TIMEOUT_MS,
};

export interface UpstreamOptions {
  /** A short label for logs and errors; never a URL. */
  target: string;
  fetch?: typeof globalThis.fetch;
  deadline?: Deadline;
  policy?: Partial<UpstreamPolicy>;
  /** Answers 404 with null instead of an error. */
  notFoundIsNull?: boolean;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const logger = new Logger("upstream");

let rateLimitHitCount = 0;
let errorCount = 0;

/**
 * How many upstream requests have been rate-limited since this process started.
 *
 * The public Horizon allows 3600 requests/hour per IP, and Cloud Run egresses every request
 * from one address, so the whole service shares that budget. A non-zero and rising count is
 * the signal to move `PATH_ROUTING_API_*` to a provider with headroom - weeks before it turns
 * into a user-visible outage.
 */
export function rateLimitHits(): number {
  return rateLimitHitCount;
}

/** Reads that ended in an `UpstreamError` since this process started. */
export function upstreamErrorCount(): number {
  return errorCount;
}

/** Test-only: clears the counters so one test's failures don't leak into another's assertion. */
export function resetUpstreamCounters(): void {
  rateLimitHitCount = 0;
  errorCount = 0;
}

const SAFE_PATH = /^\/(?!\/)[^\\\s]*$/;

/**
 * The only way a request URL is made: a trusted base from configuration plus a path-and-query
 * that must start with a single "/". Anything that could re-point the request (an absolute URL,
 * "//host", backslashes, whitespace) is refused, and the result is checked to still sit on the
 * base's origin. Callers encode each user-derived segment before it reaches here.
 */
export function resolveUpstreamUrl(baseUrl: string, path: string, target: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl.replace(/\/+$/, ""));
  } catch {
    throw new UpstreamError("unavailable", target);
  }
  if (!SAFE_PATH.test(path)) throw new UpstreamError("bad_response", target);
  const resolved = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base.origin);
  if (resolved.origin !== base.origin) throw new UpstreamError("bad_response", target);
  return resolved;
}

/**
 * Turns a provider-supplied `next` link into a path relative to the configured base.
 *
 * Compares parsed origins, not string prefixes: `https://horizon.example.attacker.com` starts
 * with `https://horizon.example`. Anything off-origin is refused rather than rewritten. The
 * result is relative to the base's own path so providers served under a prefix
 * (`https://host/horizon/v1`) do not get that prefix twice on page two onward.
 */
export function pathOnBase(href: string, baseUrl: string, target: string): string {
  let base: URL;
  let link: URL;
  try {
    base = new URL(baseUrl.replace(/\/+$/, ""));
    link = new URL(href, base);
  } catch {
    throw new UpstreamError("bad_response", target);
  }
  if (link.origin !== base.origin) throw new UpstreamError("bad_response", target);
  const basePath = base.pathname.replace(/\/+$/, "");
  const full = `${link.pathname}${link.search}`;
  if (basePath && full.startsWith(`${basePath}/`)) return full.slice(basePath.length);
  if (basePath && full === basePath) return "";
  return full;
}

export function resolveDeadline(explicit?: Deadline): Deadline {
  return explicit ?? currentDeadline() ?? createDeadline(REQUEST_DEADLINE_MS);
}

/**
 * The wait a `Retry-After` header asks for, in ms, or null when it is absent, malformed, in the
 * past or not positive. The value comes from the provider, so it is capped.
 */
export function parseRetryAfter(header: string | null, now: number, maxMs: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const date = Date.parse(value);
    if (Number.isNaN(date)) return null;
    ms = date - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, maxMs);
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

type Outcome =
  | { ok: true; body: unknown }
  | { ok: false; retryable: true; kind: UpstreamErrorKind; retryAfterMs: number | null }
  | { ok: false; retryable: false; kind: UpstreamErrorKind };

function failWith(error: UpstreamError): never {
  errorCount++;
  logger.warn({ message: "upstream read failed", target: error.target, kind: error.kind });
  throw error;
}

/**
 * GETs `path` on the configured `baseUrl` and returns its parsed JSON body, or null for a 404 when `notFoundIsNull`.
 *
 * Retries 429, 5xx, timeouts and network faults; any other status is `bad_response` at once.
 * Each attempt is bounded by the smaller of the per-attempt limit and what is left of the
 * deadline, and no backoff sleeps past the deadline.
 */
export async function upstreamGetJson<T>(
  baseUrl: string,
  path: string,
  options: UpstreamOptions
): Promise<T | null> {
  const policy = { ...DEFAULT_UPSTREAM_POLICY, ...options.policy };
  const doFetch = options.fetch ?? globalThis.fetch;
  const deadline = resolveDeadline(options.deadline);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const { target } = options;
  const url = resolveUpstreamUrl(baseUrl, path, target).href;
  let lastKind: UpstreamErrorKind = "unavailable";

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    const remaining = deadline.remainingMs();
    if (deadline.signal.aborted || remaining <= 0) failWith(new UpstreamError("timeout", target));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(policy.perAttemptMs, remaining));
    const signal = AbortSignal.any([controller.signal, deadline.signal]);

    const outcome = await (async (): Promise<Outcome> => {
      try {
        const res = await doFetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal,
        });
        if (res.status === 404 && options.notFoundIsNull) return { ok: true, body: null };
        if (res.ok) {
          try {
            return { ok: true, body: await res.json() };
          } catch {
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            return { ok: false, retryable: false, kind: "bad_response" };
          }
        }
        if (res.status === 429) {
          rateLimitHitCount++;
          return {
            ok: false,
            retryable: true,
            kind: "rate_limited",
            retryAfterMs: parseRetryAfter(
              res.headers.get("Retry-After"),
              now(),
              policy.maxRetryAfterMs
            ),
          };
        }
        if (res.status >= 500) {
          return { ok: false, retryable: true, kind: "unavailable", retryAfterMs: null };
        }
        return { ok: false, retryable: false, kind: "bad_response" };
      } catch {
        return {
          ok: false,
          retryable: true,
          kind: signal.aborted ? "timeout" : "unavailable",
          retryAfterMs: null,
        };
      } finally {
        clearTimeout(timer);
      }
    })();

    if (outcome.ok) return outcome.body as T | null;
    if (deadline.signal.aborted) failWith(new UpstreamError("timeout", target));
    if (!outcome.retryable) failWith(new UpstreamError(outcome.kind, target));
    lastKind = outcome.kind;
    if (attempt === policy.maxRetries) break;

    const wait = outcome.retryAfterMs ?? Math.floor(random() * policy.baseBackoffMs * 2 ** attempt);
    if (wait >= deadline.remainingMs()) failWith(new UpstreamError("timeout", target));
    await sleep(wait, deadline.signal);
  }

  return failWith(new UpstreamError(lastKind, target));
}
