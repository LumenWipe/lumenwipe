/**
 * Reads a human-readable message out of an API error body.
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
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const b = body as { error?: unknown; message?: unknown };

  if (typeof b.error === "object" && b.error !== null) {
    const message = (b.error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof b.error === "string" && b.error.length > 0) return b.error;
  // Nest's default filter (throttler, unknown route) has no `error` object at all.
  if (typeof b.message === "string" && b.message.length > 0) return b.message;
  return fallback;
}
