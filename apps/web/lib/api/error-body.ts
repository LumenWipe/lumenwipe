import type { ApiErrorBody } from "@lumenwipe/types";

export function errorEnvelope(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
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
