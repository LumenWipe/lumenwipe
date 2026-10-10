import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { LumenWipeApiError } from "@lumenwipe/sdk";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import { apiRequestId, requestIdHeaders } from "@/lib/api/error-body";
import { ApiRequestError, requestIdOf, toUserMessage } from "@/lib/utils/user-error";

const ID = "0b1f2f6e-5d1c-4a52-9f0e-3a8a4b7c9d10";

afterEach(() => {
  mock.restore();
});

test("apiRequestId prefers the header, falls back to the envelope and drops anything not id-shaped", () => {
  const res = (value: string | null) => ({
    headers: new Headers(value ? { "x-request-id": value } : {}),
  });
  const body = { error: { code: "x", message: "m", requestId: ID } };
  expect(apiRequestId(res("header-id-12345"), body)).toBe("header-id-12345");
  expect(apiRequestId(res(null), body)).toBe(ID);
  expect(apiRequestId(res("<script>alert(1)</script>"), {})).toBeUndefined();
  expect(apiRequestId(res(null), { error: "flat" })).toBeUndefined();
});

test("the close client carries the id from the proxy response into the thrown error", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ error: { code: "service_unavailable", message: "Try again." } }),
      {
        status: 503,
        headers: { "x-request-id": ID },
      }
    )
  );
  const error = await fetchCloseTransactions(
    { source: "G", destination: "G" } as never,
    "testnet"
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(requestIdOf(error)).toBe(ID);
});

test("the id never changes what toUserMessage says", () => {
  for (const status of [400, 422, 429, 500, 503]) {
    expect(
      toUserMessage(new ApiRequestError(status, "Choose a destination first.", ID), "review")
    ).toBe(toUserMessage(new ApiRequestError(status, "Choose a destination first."), "review"));
  }
  expect(requestIdOf(new LumenWipeApiError(500, {}, new Headers({ "X-Request-Id": ID })))).toBe(ID);
  expect(requestIdOf(new Error("x"))).toBeUndefined();
});

test("the proxy relays only an id-shaped request id as a response header", () => {
  expect(requestIdHeaders(ID)).toEqual({ "x-request-id": ID });
  expect(requestIdHeaders("bad\r\nheader")).toBeUndefined();
  expect(requestIdHeaders(undefined)).toBeUndefined();
});
