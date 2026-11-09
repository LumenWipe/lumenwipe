import "server-only";
import { NextResponse } from "next/server";
import {
  PlaygroundStoreUnavailableError,
  sessionStore,
  type PlaygroundSession,
} from "./session-store";
import { NOT_CONFIGURED, type ActionResult } from "./session-actions";

export function actionResponse(result: ActionResult): NextResponse {
  return NextResponse.json(result.body, { status: result.status });
}

export function notConfiguredResponse(): NextResponse {
  return actionResponse(NOT_CONFIGURED);
}

/**
 * Loads a session, or returns the response the route should send instead.
 *
 * The store throws `PlaygroundStoreUnavailableError` when KV is unconfigured in production, and an
 * uncaught throw inside a route handler is a 500 with a stack trace, so the catch lives here where
 * no route can forget it. Callers narrow with `instanceof NextResponse` and early-return.
 */
export async function loadSessionOrErrorResponse(
  id: string
): Promise<PlaygroundSession | NextResponse> {
  let session: PlaygroundSession | null;
  try {
    session = await sessionStore.loadSession(id);
  } catch (err) {
    if (err instanceof PlaygroundStoreUnavailableError) return notConfiguredResponse();
    throw err;
  }
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  return session;
}
