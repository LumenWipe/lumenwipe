import { errorCopy } from "./error-copy";

/** An error whose message is already plain-language copy, safe to show as is. */
export class PlaygroundApiError extends Error {}

export class SessionExpiredError extends PlaygroundApiError {}

/** The close stopped before building because the API asked for decisions the demo cannot make. */
export class DecisionBlockedError extends PlaygroundApiError {
  constructor(
    message: string,
    readonly decisionIds: string[]
  ) {
    super(message);
  }
}

/** The close stopped before building on a blocker the API reported. `resolvable` lists the ones
 *  the session's own plan can resolve. */
export class PlanBlockedError extends PlaygroundApiError {
  constructor(
    message: string,
    readonly blockers: string[],
    readonly resolvable: string[]
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const code = body.error;
  return typeof code === "string" ? code : undefined;
}

function stringsAt(body: unknown, key: string): string[] {
  if (!isRecord(body)) return [];
  const value = body[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Calls a playground route and returns its JSON, or throws an error carrying plain-language copy.
 * Only a `session_not_found` or `batch_not_found` body means the session expired: any other 404 (an unknown route, or an
 * account Horizon has not caught up with yet) is an ordinary failure.
 */
export async function playgroundRequest<T>(
  fetchImpl: FetchLike,
  path: string,
  init?: RequestInit
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new PlaygroundApiError(errorCopy("network_error"));
  }
  if (res.ok) return (await res.json()) as T;
  const body: unknown = await res.json().catch(() => null);
  const code = errorCode(body);
  if (res.status === 404 && (code === "session_not_found" || code === "batch_not_found")) {
    throw new SessionExpiredError(errorCopy(code));
  }
  if (code === "demolish_decision_unanswerable") {
    throw new DecisionBlockedError(errorCopy(code), stringsAt(body, "decisions"));
  }
  if (code === "demolish_blocked") {
    const blockers = stringsAt(body, "blockers");
    const resolvable = stringsAt(body, "resolvable").filter((c) => blockers.includes(c));
    throw new PlanBlockedError(errorCopy(code), blockers, resolvable);
  }
  throw new PlaygroundApiError(errorCopy(code, res.status));
}
