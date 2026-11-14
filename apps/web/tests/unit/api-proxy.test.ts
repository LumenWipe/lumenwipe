import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";
import {
  ApiNotConfiguredError,
  proxyErrorResponse,
  rateLimitedResponse,
} from "@/lib/api/proxy-error";

let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

async function expectEnvelope(res: Response, status: number): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
  expect(typeof body.error).toBe("object");
  expect(typeof body.error?.code).toBe("string");
  expect(typeof body.error?.message).toBe("string");
  expect((body.error?.message as string).length).toBeGreaterThan(0);
}

describe("proxy error paths speak the API's envelope", () => {
  test("timeout", async () => {
    await expectEnvelope(proxyErrorResponse(new LumenWipeTimeoutError(30_000)), 504);
  });

  test("upstream non-object body", async () => {
    const res = proxyErrorResponse(new LumenWipeApiError(502, "<html>Bad Gateway</html>"));
    await expectEnvelope(res.clone(), 502);
    expect(await res.text()).not.toContain("<html>");
  });

  test("unreachable API", async () => {
    await expectEnvelope(proxyErrorResponse(new TypeError("fetch failed")), 502);
  });

  test("config missing is a retryable 503 that names no variable", async () => {
    const res = proxyErrorResponse(new ApiNotConfiguredError("LUMENWIPE_API_URL"));
    await expectEnvelope(res.clone(), 503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.text()).not.toContain("LUMENWIPE");
  });

  test("rate limited", async () => {
    await expectEnvelope(rateLimitedResponse(), 429);
  });

  test("an upstream envelope is relayed as it came", async () => {
    const body = { error: { code: "bad_request", message: "Choose a destination first." } };
    const res = proxyErrorResponse(new LumenWipeApiError(422, body));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(body);
  });

  test("a busy API's Retry-After reaches the page", async () => {
    const body = { error: { code: "service_unavailable", message: "The data provider is busy." } };
    const res = proxyErrorResponse(
      new LumenWipeApiError(503, body, new Headers({ "Retry-After": "30" }))
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual(body);
  });

  test("no Retry-After is added where the API sent none", () => {
    const res = proxyErrorResponse(
      new LumenWipeApiError(503, { error: { code: "x", message: "m" } })
    );
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
