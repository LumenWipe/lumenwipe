import "server-only";
import { NextResponse } from "next/server";
import {
  loadSession,
  PlaygroundStoreUnavailableError,
  type PlaygroundSession,
} from "./session-store";

/** The one wording every route uses for "this deployment is missing its server-side config". */
export const NOT_CONFIGURED_MESSAGE = "Playground is not configured on this server.";

export function notConfiguredResponse(): NextResponse {
  return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 });
}

/**
 * Loads a session, or returns the response the route should send instead.
 *
 * Every route needs the same two failure answers and used to spell out only one of them:
 * `loadSession` throws `PlaygroundStoreUnavailableError` when KV is unconfigured in production,
 * and an uncaught throw inside a route handler is a 500 with a stack trace - the opposite of the
 * "user-facing errors are plain language" invariant, for a condition that is purely an operator
 * misconfiguration. Centralizing it means a new route cannot forget the catch.
 *
 * Callers narrow with `instanceof NextResponse` and early-return.
 */
export async function loadSessionOrErrorResponse(
  id: string
): Promise<PlaygroundSession | NextResponse> {
  let session: PlaygroundSession | null;
  try {
    session = await loadSession(id);
  } catch (err) {
    if (err instanceof PlaygroundStoreUnavailableError) return notConfiguredResponse();
    throw err;
  }
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  return session;
}
