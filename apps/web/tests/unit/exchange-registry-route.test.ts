import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/config/exchange-registry/route";
import * as redis from "@/lib/upstash-redis";

const realFetch = globalThis.fetch;
const realBase = process.env.LUMENWIPE_API_URL;
let calls: { url: string; init: RequestInit }[];

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function call() {
  return GET(
    new NextRequest("https://www.lumenwipe.com/api/config/exchange-registry", {
      headers: { "x-real-ip": "203.0.113.7" },
    })
  );
}

beforeEach(() => {
  calls = [];
  process.env.LUMENWIPE_API_URL = "https://api.test";
  spyOn(redis, "checkNamespacedRateLimit").mockImplementation(async () => true);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBase === undefined) delete process.env.LUMENWIPE_API_URL;
  else process.env.LUMENWIPE_API_URL = realBase;
  mock.restore();
});

test("reads the registry from the v1 path, uncached and with no API key", async () => {
  const registry = { version: "1", lastVerified: "", validUntil: "", source: "", entries: [] };
  stubFetch(200, registry);

  const res = await call();

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(registry);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.test/v1/config/exchange-registry");
  expect(calls[0].init.cache).toBe("no-store");
  expect(calls[0].init.headers).toBeUndefined();
});

test("passes an upstream failure status through without a fabricated registry", async () => {
  stubFetch(503, { error: { code: "service_unavailable", message: "down" } });

  const res = await call();

  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "registry_unavailable"
  );
});
