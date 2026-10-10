/**
 * Reads a human-readable message out of an API error body, discarding any that doesn't read as
 * plain language (codes, stack-shaped text, status numbers) in favor of the caller's fallback.
 *
 * The API speaks one envelope - `{ error: { code, message } }` - but three things make a
 * defensive reader worth having anyway: an in-flight rollout can still serve the previous flat
 * shape, Nest's own filters emit `{ statusCode, message }` for throttling and unknown routes,
 * and `res.json()` is `any`, so nothing here is checked by the compiler.
 *
 * That last point is why this exists as a function rather than a field access. Passing the body
 * straight to a `useState<string>` compiled fine and crashed the render with "Objects are not
 * valid as a React child" the moment the envelope changed shape.
 */
export function looksPlain(message: string): boolean {
  return (
    message.length > 0 &&
    message.length <= 240 &&
    !/\b(tx|op)_[a-z_]+\b/.test(message) &&
    !/\b\w*(Error|Exception)\b|\bat \S+ \(|undefined|\[object|[{}]|\(\d{3}\)/.test(message)
  );
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

/** The id the API gave this request: the response header, else the envelope. Shown to the user,
 *  so anything that is not id-shaped is dropped. */
export function apiRequestId(
  res: { headers: Pick<Headers, "get"> },
  body: unknown
): string | undefined {
  const fromBody =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "object"
      ? ((body as { error: { requestId?: unknown } | null }).error?.requestId ?? undefined)
      : undefined;
  const candidate = res.headers.get("x-request-id") ?? fromBody;
  return isRequestId(candidate) ? candidate : undefined;
}

/** The header the proxy relays so a failed call can be tied to the API's log line. */
export function requestIdHeaders(requestId: unknown): Record<string, string> | undefined {
  return isRequestId(requestId) ? { "x-request-id": requestId } : undefined;
}

export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const b = body as { error?: unknown; message?: unknown };

  if (typeof b.error === "object" && b.error !== null) {
    const message = (b.error as { message?: unknown }).message;
    if (typeof message === "string" && looksPlain(message)) return message;
  }
  if (typeof b.error === "string" && looksPlain(b.error)) return b.error;
  // Nest's default filter (throttler, unknown route) has no `error` object at all.
  if (typeof b.message === "string" && looksPlain(b.message)) return b.message;
  return fallback;
}
