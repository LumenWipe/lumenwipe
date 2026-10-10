import type { ErrorCode } from "@lumenwipe/types";

/** An `ErrorCode` the API can return, or `"upstream_error"` for a non-JSON failure from a proxy
 *  or CDN in front of it. The open `string` arm keeps a newer API's code from breaking a build. */
export type ApiErrorCode = ErrorCode | "upstream_error" | (string & {});

function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function readEnvelope(
  body: unknown
): { code: string; message: string; details?: unknown } | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message, details } = error as Record<string, unknown>;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { code, message, details };
}

/** Thrown when the API responds with a non-2xx status. `body` is the parsed error payload. */
export class LumenWipeApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    readonly status: number,
    readonly body: unknown,
    headers?: Pick<Headers, "get">
  ) {
    const envelope = readEnvelope(body);
    super(
      envelope
        ? `LumenWipe API error ${status} ${envelope.code}: ${envelope.message}`
        : `LumenWipe API error ${status}`
    );
    this.name = "LumenWipeApiError";
    this.code = envelope?.code ?? "upstream_error";
    this.details = envelope?.details;
    this.retryAfterMs = parseRetryAfterMs(headers?.get("Retry-After"));
    this.requestId = headers?.get("X-Request-Id") ?? undefined;
  }
}

/** Narrows an unknown error to a `LumenWipeApiError` carrying the given `code`. */
export function isApiErrorCode<C extends ApiErrorCode>(
  error: unknown,
  code: C
): error is LumenWipeApiError & { code: C } {
  return error instanceof LumenWipeApiError && error.code === code;
}

/** Thrown when a request exceeds the configured timeout. */
export class LumenWipeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LumenWipe API request timed out after ${timeoutMs}ms`);
    this.name = "LumenWipeTimeoutError";
  }
}

/** Thrown when the caller's `signal` aborts a request. Distinct from a timeout. */
export class LumenWipeAbortError extends Error {
  constructor(readonly reason?: unknown) {
    super("LumenWipe API request was aborted");
    this.name = "LumenWipeAbortError";
  }
}
