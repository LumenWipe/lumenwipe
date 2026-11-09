import { test, expect } from "bun:test";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
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
