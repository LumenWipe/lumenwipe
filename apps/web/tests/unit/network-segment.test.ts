import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { refuseUnknownNetwork } from "@/lib/api/network-segment";
import { config, proxy } from "@/proxy";

const ORIGIN = "https://www.lumenwipe.com";
const API_DIR = join(import.meta.dir, "../../app/api");

const REFUSED_SEGMENTS = [
  "..%2Fadmin",
  "testnet%2F..%2Fadmin",
  "testnet%3Fx=1%23",
  "..",
  "%2e%2e",
  "",
  "%20",
  "TESTNET",
  "Mainnet",
  "..%252Fadmin",
  "testnet%252F..%252Fadmin",
  "%252e%252e%252fadmin",
  "%2574estnet",
  "testnet%00",
  "testnet%20",
  "%E0%A4%A",
  "public",
];

function routePaths(dir = API_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return routePaths(join(dir, entry.name));
    return entry.name === "route.ts" ? [`/api/${relative(API_DIR, dir)}`] : [];
  });
}

const NETWORK_ROUTES = routePaths().filter((path) => path.includes("[network]"));
const OTHER_ROUTES = routePaths().filter((path) => !path.includes("[network]"));

function concrete(route: string, network: string): string {
  return route.replace("[network]", network).replace(/\[\w+\]/g, "x");
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({
    error: { code: "invalid_network", message: "Unknown network." },
  });
}

describe("refuseUnknownNetwork", () => {
  test("every route under a network segment is found", () => {
    expect(NETWORK_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  test.each(NETWORK_ROUTES)("%s accepts mainnet and testnet", (route) => {
    expect(refuseUnknownNetwork(concrete(route, "mainnet"))).toBeNull();
    expect(refuseUnknownNetwork(concrete(route, "testnet"))).toBeNull();
  });

  test.each(NETWORK_ROUTES)("%s refuses every other value", async (route) => {
    for (const segment of REFUSED_SEGMENTS) {
      const res = refuseUnknownNetwork(concrete(route, segment));
      if (!res) throw new Error(`${segment} was accepted on ${route}`);
      await expectRefused(res);
    }
  });

  test.each(OTHER_ROUTES)("%s has no network segment to check", (route) => {
    expect(refuseUnknownNetwork(concrete(route, ""))).toBeNull();
  });

  test("reads each segment decoded, as the route handler would", async () => {
    expect(refuseUnknownNetwork("/api/%74estnet/account/G")).toBeNull();
    const res = refuseUnknownNetwork("/%61pi/v%31/TESTNET/submit");
    if (!res) throw new Error("the encoded path was accepted");
    await expectRefused(res);
  });

  test("a path outside the API is left alone", () => {
    expect(refuseUnknownNetwork("/")).toBeNull();
    expect(refuseUnknownNetwork("/testnet/close")).toBeNull();
    expect(refuseUnknownNetwork("/api")).toBeNull();
  });
});

describe("proxy", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  test("runs for every API path", () => {
    expect(config.matcher).toContain("/api/:path*");
  });

  test.each(["mainnet", "testnet"])("forwards %s with no CSP header", (network) => {
    const res = proxy(new NextRequest(`${ORIGIN}/api/${network}/account/G`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test.each(REFUSED_SEGMENTS.filter((s) => s !== ".." && s !== "%2e%2e"))(
    "answers %p itself, so no route handler runs",
    async (segment) => {
      const res = proxy(new NextRequest(`${ORIGIN}/api/${segment}/account/G`));
      expect(res.headers.get("x-middleware-next")).toBeNull();
      await expectRefused(res);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  test("still sets the CSP on a page", () => {
    const res = proxy(new NextRequest(`${ORIGIN}/testnet/close`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
