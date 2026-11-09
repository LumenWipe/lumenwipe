import { errorCopy } from "./error-copy";

export class SessionExpiredError extends Error {}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" ? code : undefined;
}

/**
 * Calls a playground route and returns its JSON, or throws an error carrying plain-language copy.
 * Only a `session_not_found` body means the session expired: any other 404 (an unknown route, or an
 * account Horizon has not caught up with yet) is an ordinary failure.
 */
export async function playgroundRequest<T>(
  fetchImpl: FetchLike,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetchImpl(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.ok) return (await res.json()) as T;
  const code = errorCode(await res.json().catch(() => null));
  if (res.status === 404 && code === "session_not_found") {
    throw new SessionExpiredError(errorCopy(code));
  }
  throw new Error(errorCopy(code, res.status));
}
