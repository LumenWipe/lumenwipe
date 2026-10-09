import { afterEach, describe, expect, test } from "bun:test";
import { createKey, IntegratorRequestError, listKeys } from "@/lib/integrator/client";
import { buildUpstreamRequest } from "@/lib/integrator/upstream";

const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("buildUpstreamRequest", () => {
  test("forwards only the caller's session authorization", () => {
    const { url, init } = buildUpstreamRequest(
      "http://api.test/",
      "keys",
      "GET",
      "Bearer lws.session",
      ""
    );
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("http://api.test/integrator/keys");
    expect(headers.Authorization).toBe("Bearer lws.session");
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("x-api-key");
  });

  test("sends no authorization when the caller has none", () => {
    const { init } = buildUpstreamRequest("http://api.test", "auth/challenge", "POST", null, "{}");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.body).toBe("{}");
  });

  test("never sends a body on GET", () => {
    const { init } = buildUpstreamRequest("http://api.test", "keys", "GET", null, "ignored");
    expect(init.body).toBeUndefined();
  });
});

describe("integrator client", () => {
  test("sends the session token as a bearer credential", async () => {
    const { calls } = stubFetch(200, { keys: [], usage: { today: 0, last30Days: 0 } });
    await listKeys("lws.token");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer lws.token"
    );
    expect(calls[0].url).toBe("/api/integrator/keys");
  });

  test("surfaces the API's plain-language error message", async () => {
    stubFetch(409, { error: { code: "key_limit_reached", message: "Revoke one first." } });
    const error = await createKey("lws.token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegratorRequestError);
    expect((error as IntegratorRequestError).message).toBe("Revoke one first.");
    expect((error as IntegratorRequestError).status).toBe(409);
  });

  test("asks the user to sign in again on 401 without a message", async () => {
    stubFetch(401, {});
    const error = await listKeys("lws.old").catch((e: unknown) => e);
    expect((error as IntegratorRequestError).message).toBe("Your session expired. Sign in again.");
  });

  test("reports a network failure in plain language", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await listKeys("lws.token").catch((e: unknown) => e);
    expect((error as IntegratorRequestError).message).toContain("Could not reach LumenWipe");
  });
});
