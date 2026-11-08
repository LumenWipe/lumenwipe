import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const API_DIR = join(import.meta.dir, "../../app/api");
const UPSTREAM = "https://upstream.invalid";
const LIMITER = "https://limiter.invalid";
const ENV = {
  LUMENWIPE_API_URL: UPSTREAM,
  LUMENWIPE_API_KEY: "test-key",
  UPSTASH_REDIS_REST_URL: LIMITER,
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

/** 30.25 s before 00:00 UTC, so a 429 from any route must say to retry in 31 s. */
const NOW = new Date("2026-11-08T23:59:29.750Z");
const RETRY_AFTER = "31";

/** The routes that never ask the per-IP limiter: they attach no key and read nothing per caller
 *  that the API does not already cache. A new route outside this list must answer 429 here. */
const UNLIMITED = ["/health/route.ts", "/stats/route.ts", "/stats/feed/route.ts"];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Routes whose limiter guards only some requests: the rest are refused or ignored uncounted. */
const LIMITED_REQUESTS: Record<string, { methods: readonly string[]; contentType: string }> = {
  "/csp-report/route.ts": { methods: ["POST"], contentType: "application/reports+json" },
};

type Handler = (
  req: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

function routeFiles(dir = API_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const FILES = routeFiles().map((path) => [path.slice(API_DIR.length), path] as const);
const LIMITED = FILES.filter(([route]) => !UNLIMITED.includes(route));

let fetchSpy: ReturnType<typeof spyOn>;
const saved = new Map<string, string | undefined>();

/** The origin a fetch was sent to, or null for an input that is not a URL. */
function originOf(input: unknown): string | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).origin;
  } catch {
    return null;
  }
}

function callsTo(origin: string): number {
  return (fetchSpy.mock.calls as unknown[][]).filter(([input]) => originOf(input) === origin)
    .length;
}

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  // Every caller is far over every bucket.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    if (originOf(input) === LIMITER) return Response.json([{ result: 100_000 }, { result: 1 }]);
    return Response.json({});
  }) as unknown as typeof globalThis.fetch);
  setSystemTime(NOW);
});

beforeEach(() => fetchSpy.mockClear());

afterAll(() => {
  setSystemTime();
  fetchSpy.mockRestore();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("route handlers over the rate limit", () => {
  test("every unlimited route exists, and the walk finds the limited ones", () => {
    const routes = FILES.map(([route]) => route);
    for (const route of UNLIMITED) expect(routes).toContain(route);
    expect(LIMITED.length).toBeGreaterThanOrEqual(19);
  });

  test.each(LIMITED)(
    "%s answers 429 with Retry-After and no-store, and never calls the API",
    async (route, file) => {
      const mod = (await import(file)) as Partial<Record<(typeof METHODS)[number], Handler>>;
      const only = LIMITED_REQUESTS[route];
      const methods = METHODS.filter(
        (method) => typeof mod[method] === "function" && (!only || only.methods.includes(method))
      );
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        fetchSpy.mockClear();
        const req = new NextRequest("https://www.lumenwipe.com/api/route", {
          method,
          headers: {
            "content-type": only?.contentType ?? "application/json",
            origin: "https://www.lumenwipe.com",
          },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        });
        const res = await mod[method]!(req, {
          params: Promise.resolve({
            network: "testnet",
            address: "G",
            hash: "a".repeat(64),
            id: "key-id",
          }),
        });
        expect(`${method} ${res.status}`).toBe(`${method} 429`);
        expect(res.headers.get("Retry-After")).toBe(RETRY_AFTER);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
        expect(callsTo(LIMITER)).toBe(1);
        expect(callsTo(UPSTREAM)).toBe(0);
      }
    }
  );
});
