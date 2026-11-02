import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { GET as paths } from "@/app/api/[network]/paths/route";
import { GET as check } from "@/app/api/[network]/mediator/check/[address]/route";
import * as rateLimit from "@/lib/api/rate-limit";
import * as serverClient from "@/lib/api/server-client";

const WEB_ROOT = join(import.meta.dir, "..", "..");
const API_DIR = join(WEB_ROOT, "app", "api");
const DOCS = join(WEB_ROOT, "..", "..", "docs", "architecture.md");
/** Both networks' figures in one body, so no network can be served the other's. */
const NETWORK_FREE = ["/api/stats", "/api/stats/feed"];

function routeFiles(dir = API_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

function cachedRoutes(): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return routeFiles()
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        transpiler.transformSync(source).includes("s-maxage") ||
        transpiler.scan(source).exports.includes("revalidate")
      );
    })
    .map((file) => `/api/${relative(API_DIR, file).replace(/\/route\.ts$/, "")}`)
    .sort();
}

function documentedRoutes(): string[] {
  const docs = readFileSync(DOCS, "utf8");
  const section = docs.slice(docs.indexOf("### 7.2 Caching"), docs.indexOf("### 7.3"));
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `/api/"))
    .map((line) => line.split("`")[1])
    .sort();
}

let askedFor: string[];

function pathsRequest(network: string): Promise<NextResponse> {
  const req = new NextRequest(
    `https://www.lumenwipe.com/api/${network}/paths?fromAsset=native&amount=12.5`
  );
  return paths(req, { params: Promise.resolve({ network }) }) as Promise<NextResponse>;
}

function checkRequest(network: string): Promise<NextResponse> {
  const req = new NextRequest(`https://www.lumenwipe.com/api/${network}/mediator/check/G`);
  return check(req, {
    params: Promise.resolve({ network, address: "G" }),
  }) as Promise<NextResponse>;
}

beforeEach(() => {
  askedFor = [];
  spyOn(rateLimit, "rateLimitProxy").mockImplementation((async () => null) as never);
  spyOn(serverClient, "getApiClient").mockImplementation(
    () =>
      ({
        getPaths: async (_: unknown, network: string) => {
          askedFor.push(network);
          return {};
        },
        mediatorCheck: async (_: unknown, network: string) => {
          askedFor.push(network);
          return {};
        },
      }) as never
  );
});

afterEach(() => {
  mock.restore();
});

describe("response headers", () => {
  test.each(["testnet", "mainnet"])("a %s path quote is never stored", async (network) => {
    const res = await pathsRequest(network);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test.each(["testnet", "mainnet"])("a %s destination check keeps its window", async (network) => {
    const res = await checkRequest(network);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120"
    );
  });
});

describe("the cache key", () => {
  test("each route answers for the network in its own URL", async () => {
    await pathsRequest("testnet");
    await pathsRequest("mainnet");
    await checkRequest("testnet");
    await checkRequest("mainnet");
    expect(askedFor).toEqual(["testnet", "mainnet", "testnet", "mainnet"]);
  });

  test("every cached route carries the network in its URL or serves both networks", () => {
    const unkeyed = cachedRoutes()
      .filter((route) => !route.includes("[network]") && !NETWORK_FREE.includes(route))
      .map(
        (route) =>
          `${route} is cached with no [network] segment, so the CDN would share one answer across networks. Move it under app/api/[network]/, or add it to NETWORK_FREE only if one body carries both networks.`
      );
    expect(unkeyed).toEqual([]);
  });
});

test("every cached route is documented", () => {
  const cached = cachedRoutes();
  const documented = documentedRoutes();
  const problems = [
    ...cached
      .filter((route) => !documented.includes(route))
      .map(
        (route) =>
          `${route} is cached but has no row in docs/architecture.md Section 7.2. Add "| \`${route}\` | <time to live> | <why it cannot affect a signed value> |".`
      ),
    ...documented
      .filter((route) => !cached.includes(route))
      .map(
        (route) =>
          `${route} is in docs/architecture.md Section 7.2 but is no longer cached. Delete its row.`
      ),
  ];
  expect(problems).toEqual([]);
});
