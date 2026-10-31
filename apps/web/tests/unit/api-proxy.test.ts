import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";
import { proxyErrorResponse, rateLimitedResponse } from "@/lib/api/proxy-error";

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

  test("config missing", async () => {
    await expectEnvelope(
      proxyErrorResponse(new Error("LUMENWIPE_API_URL is not configured.")),
      502
    );
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
});
