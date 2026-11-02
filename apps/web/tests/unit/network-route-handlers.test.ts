import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { LumenWipeInvalidNetworkError, type Network } from "@lumenwipe/sdk";
import { proxyErrorResponse } from "@/lib/api/proxy-error";

const API_DIR = join(import.meta.dir, "../../app/api");
const UPSTREAM = "https://upstream.invalid";
const LIMITER = "https://limiter.invalid";
const ENV = {
  LUMENWIPE_API_URL: UPSTREAM,
  LUMENWIPE_API_KEY: "test-key",
  UPSTASH_REDIS_REST_URL: LIMITER,
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

type Handler = (
  req: NextRequest,
  context: { params: Promise<{ network: string; address: string }> }
) => Promise<NextResponse>;

function routeFiles(dir = API_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const ROUTES = routeFiles()
  .filter((path) => path.includes("[network]"))
  .map((path) => [path.slice(API_DIR.length), path] as const);

const REFUSED = [
  "stats",
  "config",
  "health",
  "integrator",
  "../admin",
  "testnet/../admin",
  "testnet?x=1#",
  "..",
  "",
  "TESTNET",
  "%2e%2e",
];

let fetchSpy: ReturnType<typeof spyOn>;
const saved = new Map<string, string | undefined>();

function callsTo(origin: string): number {
  return (fetchSpy.mock.calls as unknown[][]).filter(([input]) => String(input).startsWith(origin))
    .length;
}

async function call(file: string, network: string, query = ""): Promise<NextResponse> {
  const mod = (await import(file)) as { GET?: Handler; POST?: Handler };
  const method = mod.POST ? "POST" : "GET";
  const handler = mod.POST ?? mod.GET;
  if (!handler) throw new Error(`${file} exports no handler`);
  const req = new NextRequest(`https://www.lumenwipe.com/api/route${query}`, {
    method,
    body: method === "POST" ? "{}" : undefined,
  });
  return handler(req, { params: Promise.resolve({ network, address: "G", hash: "a".repeat(64) }) });
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({
    error: { code: "invalid_network", message: "Unknown network." },
  });
}

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const pipeline = new URL(String(input)).origin === LIMITER;
    return Response.json(pipeline ? [{ result: 1 }, { result: 1 }] : {});
  }) as unknown as typeof globalThis.fetch);
});

beforeEach(() => fetchSpy.mockClear());

afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("route handlers with a [network] param", () => {
  test("all of them are found", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  test.each(ROUTES)("%s forwards a known network", async (_, file) => {
    const res = await call(file, "testnet");
    expect(res.status).toBe(200);
    expect(callsTo(LIMITER)).toBe(1);
    expect(callsTo(UPSTREAM)).toBe(1);
  });

  test.each(ROUTES)("%s refuses any other value, with no fetch", async (_, file) => {
    for (const network of REFUSED) {
      await expectRefused(await call(file, network));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(ROUTES)("%s refuses a param set from the nxtPnetwork query", async (_, file) => {
    const res = await call(file, "../admin", "?nxtPnetwork=..%2Fadmin");
    await expectRefused(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the API client inside proxy()", () => {
  test("an unknown network is answered as invalid_network, with no fetch", async () => {
    const { proxy } = await import("@/lib/api/proxy");
    const { getApiClient } = await import("@/lib/api/server-client");
    await expectRefused(await proxy(() => getApiClient().getAccount("G", "stats" as Network)));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("proxyErrorResponse maps the SDK error", async () => {
    await expectRefused(proxyErrorResponse(new LumenWipeInvalidNetworkError()));
  });
});
