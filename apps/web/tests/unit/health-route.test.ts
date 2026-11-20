import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { LumenWipeAbortError } from "@lumenwipe/sdk";
import { GET } from "@/app/api/health/route";
import { ApiNotConfiguredError } from "@/lib/api/proxy-error";
import * as serverClient from "@/lib/api/server-client";

/** A health call that settles only when its signal aborts, like an API that never answers. */
function hangingHealth(seen: { signal?: AbortSignal }) {
  return async (options?: { signal?: AbortSignal }) => {
    seen.signal = options?.signal;
    await new Promise((_, reject) =>
      options?.signal?.addEventListener("abort", () => reject(new LumenWipeAbortError()))
    );
  };
}

afterEach(() => {
  mock.restore();
});

test("health › a reachable API answers 200, cached for 10 seconds", async () => {
  spyOn(serverClient, "getApiClient").mockImplementation(
    () => ({ health: async () => ({ status: "ok" }) }) as never
  );
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", api: "ok" });
  expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=10");
});

test("health › an API that never answers is given up on in under 3 seconds", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  const seen: { signal?: AbortSignal } = {};
  spyOn(serverClient, "getApiClient").mockImplementation(
    () => ({ health: hangingHealth(seen) }) as never
  );
  const pending = GET();
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(timeout.mock.calls[0]![0]).toBeLessThan(3_000);
  expect(seen.signal).toBe(controller.signal);
  controller.abort();
  const res = await pending;
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "degraded", api: "error" });
  expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=10");
});

test("health › an unconfigured API answers 503", async () => {
  spyOn(serverClient, "getApiClient").mockImplementation(() => {
    throw new ApiNotConfiguredError("LUMENWIPE_API_URL");
  });
  const res = await GET();
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "degraded", api: "error" });
});

test("health › the route never asks for deep health", async () => {
  const healthDeep = mock(async () => ({}));
  spyOn(serverClient, "getApiClient").mockImplementation(
    () => ({ health: async () => ({ status: "ok" }), healthDeep }) as never
  );
  await GET();
  expect(healthDeep).not.toHaveBeenCalled();
});
