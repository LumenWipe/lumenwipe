import { test, expect } from "bun:test";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  DecisionBlockedError,
  PlanBlockedError,
  PlaygroundApiError,
  playgroundRequest,
  SessionExpiredError,
  type FetchLike,
} from "@/lib/playground-api";

const respond =
  (status: number, body: unknown): FetchLike =>
  async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

const failure = async (fetchImpl: FetchLike): Promise<unknown> =>
  playgroundRequest(fetchImpl, "/session/s1/state").then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err
  );

test("a successful response returns its JSON", async () => {
  expect(await playgroundRequest(respond(200, { done: true }), "/x")).toEqual({ done: true });
});

test("a session_not_found 404 is an expired session", async () => {
  const err = await failure(respond(404, { error: "session_not_found" }));
  expect(err).toBeInstanceOf(SessionExpiredError);
});

test("a 404 with any other body is not an expired session", async () => {
  for (const body of [{ error: "account_not_found" }, undefined, "<html>Not Found</html>"]) {
    const err = await failure(respond(404, body));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as Error).message).toBe(GENERIC_ERROR_COPY);
  }
});

test("a 503 reads as the demo being temporarily unavailable", async () => {
  const err = await failure(respond(503, { error: "not_configured" }));
  expect((err as Error).message).toBe(errorCopy("not_configured"));
  const bare = await failure(respond(503, undefined));
  expect((bare as Error).message).toBe(errorCopy("not_configured"));
});

test("an error's copy comes from its code, never from the response text", async () => {
  const err = await failure(respond(502, { error: "tx_failed", detail: "op_underfunded" }));
  expect((err as Error).message).toBe(errorCopy("tx_failed"));
  expect((err as Error).message).not.toContain("op_underfunded");
});

test("a fetch that never reaches the server carries the network copy, not the browser's text", async () => {
  const err = await failure(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(err).toBeInstanceOf(PlaygroundApiError);
  expect(err).not.toBeInstanceOf(SessionExpiredError);
  expect((err as Error).message).toBe(errorCopy("network_error"));
  expect((err as Error).message).not.toContain("Failed to fetch");
});

test("every failure response is a PlaygroundApiError carrying copy", async () => {
  expect(await failure(respond(502, { error: "tx_failed" }))).toBeInstanceOf(PlaygroundApiError);
  expect(await failure(respond(404, { error: "session_not_found" }))).toBeInstanceOf(
    PlaygroundApiError
  );
});

test("a round stopped on a decision carries the decision ids, and only strings among them", async () => {
  const err = await failure(
    respond(422, { error: "demolish_decision_unanswerable", decisions: ["claim:1", 7, null, "x"] })
  );
  expect(err).toBeInstanceOf(DecisionBlockedError);
  expect(err).toBeInstanceOf(PlaygroundApiError);
  expect((err as DecisionBlockedError).decisionIds).toEqual(["claim:1", "x"]);
  expect((err as Error).message).toBe(errorCopy("demolish_decision_unanswerable"));
  const bare = await failure(respond(422, { error: "demolish_decision_unanswerable" }));
  expect((bare as DecisionBlockedError).decisionIds).toEqual([]);
  const other = await failure(respond(422, { error: "invalid_selection", decisions: ["x"] }));
  expect(other).not.toBeInstanceOf(DecisionBlockedError);
});

test("a round stopped on a blocker carries its codes, and only the resolvable ones it names", async () => {
  const err = await failure(
    respond(422, {
      error: "demolish_blocked",
      blockers: ["sponsorship_unaffordable", 7, "subentries_unenumerated"],
      resolvable: ["sponsorship_unaffordable", "not_a_blocker_here"],
    })
  );
  if (!(err instanceof PlanBlockedError)) throw new Error("expected a PlanBlockedError");
  expect(err.blockers).toEqual(["sponsorship_unaffordable", "subentries_unenumerated"]);
  expect(err.resolvable).toEqual(["sponsorship_unaffordable"]);
  expect(err.message).toBe(errorCopy("demolish_blocked"));
});
