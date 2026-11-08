import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { LumenWipeApiError, type PlanResponse } from "@lumenwipe/sdk";
import { POST } from "@/app/api/[network]/estimate/route";
import { PROXY_LIMIT_PER_DAY, rateLimitProxy } from "@/lib/api/rate-limit";
import * as serverClient from "@/lib/api/server-client";
import * as redis from "@/lib/upstash-redis";
import { freshAccount } from "./fixtures/fresh-plan";

const ADDRESS = Keypair.random().publicKey();
const API_DIR = join(import.meta.dir, "..", "..", "app", "api");

const PLAN = {
  planHash: "h",
  status: "ready",
  steps: [],
  decisionPoints: [],
  blockers: [{ code: "issuer_has_supply", message: `Account ${ADDRESS} issues an asset.` }],
  estimate: { feeStroops: "500", freedReserveXlm: "1" },
  execution: { estimatedTransactionCount: null, transactions: [] },
} as unknown as PlanResponse;

let counted: Array<[string, number]>;
let getAccount: ReturnType<typeof mock>;
let closePlan: ReturnType<typeof mock>;

beforeEach(() => {
  counted = [];
  spyOn(redis, "checkNamespacedRateLimit").mockImplementation(async (namespace, _ip, limit) => {
    counted.push([namespace, limit]);
    return "allowed";
  });
  getAccount = mock(async () => freshAccount(ADDRESS));
  closePlan = mock(async () => PLAN);
  spyOn(serverClient, "getApiClient").mockImplementation(
    () => ({ getAccount, closePlan }) as unknown as ReturnType<typeof serverClient.getApiClient>
  );
});

afterEach(() => mock.restore());

function call(body: unknown, network = "mainnet"): Promise<NextResponse> {
  const req = new NextRequest(`https://www.lumenwipe.com/api/${network}/estimate`, {
    method: "POST",
    headers: { "x-real-ip": "203.0.113.7" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ network }) });
}

test("an estimate is counted in its own bucket, at its own limit", async () => {
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(200);
  expect(counted).toEqual([["proxy:estimate", 50]]);
});

test("the close flow's buckets keep the default limit", async () => {
  await rateLimitProxy(
    new NextRequest("https://www.lumenwipe.com/api/mainnet/account/G"),
    "account"
  );
  expect(counted).toEqual([["proxy:account", PROXY_LIMIT_PER_DAY]]);
  expect(PROXY_LIMIT_PER_DAY).toBe(500);
});

test("no route but the estimate passes its own limit", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : []
    );
  const withOwnLimit = files(API_DIR)
    .filter((file) => /limitPerDay:/.test(readFileSync(file, "utf8")))
    .map((file) => relative(API_DIR, file));
  expect(withOwnLimit).toEqual(["[network]/estimate/route.ts"]);
});

test("the answer is the range and the read time, with no address and no account state", async () => {
  const res = await call({ address: ADDRESS });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const text = await res.text();
  expect(text).not.toContain(ADDRESS);
  const body = JSON.parse(text) as { readAt: string; range: Record<string, unknown> };
  expect(Object.keys(body).sort()).toEqual(["range", "readAt"]);
  expect(Number.isNaN(Date.parse(body.readAt))).toBe(false);
  expect(body.range.lowStroops).toBe((BigInt(125_000_000) - BigInt(600)).toString());
  expect(body.range.blockers).toBe(1);
  expect(getAccount.mock.calls[0]).toEqual([ADDRESS, "mainnet"]);
  expect(closePlan.mock.calls[0]).toEqual([{ source: ADDRESS }, "mainnet"]);
});

test.each([
  ["no body", ""],
  ["a body that is not JSON", "{"],
  ["no address", {}],
  ["an address that is not a string", { address: 7 }],
  ["a checksum typo", { address: ADDRESS.slice(0, -1) + (ADDRESS.endsWith("A") ? "B" : "A") }],
])("%s is counted, then refused before the API is asked", async (_, body) => {
  const res = await call(body);
  expect(counted).toEqual([["proxy:estimate", 50]]);
  expect(res.status).toBe(400);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(getAccount).not.toHaveBeenCalled();
  expect(closePlan).not.toHaveBeenCalled();
});

test("an unknown network is refused before anything is counted", async () => {
  const res = await call({ address: ADDRESS }, "devnet");
  expect(res.status).toBe(400);
  expect(counted).toEqual([]);
  expect(getAccount).not.toHaveBeenCalled();
});

test("a refusal by the limiter asks the API nothing", async () => {
  spyOn(redis, "checkNamespacedRateLimit").mockImplementation(async () => "limited");
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(429);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(getAccount).not.toHaveBeenCalled();
});

test("an unavailable limiter refuses with a retryable 503 and asks the API nothing", async () => {
  spyOn(redis, "checkNamespacedRateLimit").mockImplementation(async () => "unavailable");
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(503);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Retry-After")).toBe("30");
  expect(await res.json()).toEqual({
    error: { code: "service_unavailable", message: "The service is temporarily unavailable." },
  });
  expect(getAccount).not.toHaveBeenCalled();
  expect(closePlan).not.toHaveBeenCalled();
});

test("a disabled limiter (local or CI) lets the estimate through", async () => {
  spyOn(redis, "checkNamespacedRateLimit").mockImplementation(async () => "disabled");
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(200);
  expect(getAccount).toHaveBeenCalledTimes(1);
});

test("a failed read keeps its status but never the upstream text, which may quote the address", async () => {
  getAccount.mockImplementation(async () => {
    throw new LumenWipeApiError(404, {
      error: { code: "account_not_found", message: `Account ${ADDRESS} not found.` },
    });
  });
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const text = await res.text();
  expect(text).not.toContain(ADDRESS);
  expect(JSON.parse(text)).toEqual({
    error: { code: "account_not_found", message: "The account does not exist on this network." },
  });
});

test("a plan with no usable fee is a failure, not a zero", async () => {
  closePlan.mockImplementation(async () => ({ ...PLAN, estimate: { feeStroops: "" } }));
  const res = await call({ address: ADDRESS });
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "estimate_unavailable"
  );
});
