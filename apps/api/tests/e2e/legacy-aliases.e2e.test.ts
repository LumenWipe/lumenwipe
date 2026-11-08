import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";

const KEY = "e2e_alias_key";
const OTHER_KEY = "e2e_alias_other_key";
const LIMIT = 120;
const SUNSET = "Tue, 01 Jun 2027 00:00:00 GMT";
const POLICY =
  '<https://docs.lumenwipe.com/api-reference/introduction#versioning>; rel="deprecation"';

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
const written: string[] = [];

beforeAll(async () => {
  process.env.API_KEYS = `alias=${KEY},other=${OTHER_KEY}`;
  delete process.env.INTEGRATOR_SESSION_SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger((line) => written.push(line)));
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

let nextHost = 1;
const freshIp = (): { "X-Forwarded-For": string } => ({
  "X-Forwarded-For": `198.18.7.${nextHost++}`,
});

function expectDeprecated(headers: Record<string, string>, successor: string): void {
  expect(headers["deprecation"]).toBe("@1794182400");
  expect(headers["sunset"]).toBe(SUNSET);
  expect(headers["link"]).toBe(`<${successor}>; rel="successor-version", ${POLICY}`);
}

function expectNotDeprecated(headers: Record<string, string>): void {
  expect(headers["deprecation"]).toBeUndefined();
  expect(headers["sunset"]).toBeUndefined();
  expect(headers["link"]).toBeUndefined();
}

function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("error" in body)) return body;
  const { error } = body as { error: Record<string, unknown> };
  return { ...body, error: { ...error, requestId: undefined } };
}

interface Case {
  method: "get" | "post";
  legacy: string;
  body?: object;
}

const CASES: Case[] = [
  { method: "get", legacy: "/testnet/account/NOPE" },
  { method: "get", legacy: "/testnet/allowances/NOPE" },
  { method: "post", legacy: "/testnet/allowances/revoke", body: {} },
  { method: "get", legacy: "/testnet/paths" },
  { method: "get", legacy: "/testnet/paths?fromAsset=nope&amount=-1" },
  { method: "post", legacy: "/testnet/mediator/sign", body: {} },
  { method: "get", legacy: "/testnet/mediator/check/NOPE" },
  { method: "post", legacy: "/testnet/fee-bump/sponsor", body: { transaction: "AAAA" } },
  { method: "get", legacy: "/config/exchange-registry" },
  { method: "post", legacy: "/integrator/auth/challenge", body: {} },
  { method: "post", legacy: "/integrator/auth/session", body: {} },
  { method: "get", legacy: "/integrator/keys" },
  { method: "post", legacy: "/integrator/keys", body: {} },
  { method: "post", legacy: "/integrator/keys/x/revoke", body: {} },
  { method: "post", legacy: "/integrator/keys/x/rotate", body: {} },
  { method: "get", legacy: "/badnet/account/NOPE" },
];

async function call(c: Case, path: string): Promise<request.Response> {
  const req = request(http)[c.method](path).set("Authorization", `Bearer ${KEY}`).set(freshIp());
  return c.body === undefined ? req : req.send(c.body);
}

test.each(CASES.map((c) => [`${c.method.toUpperCase()} ${c.legacy}`, c] as const))(
  "%s answers exactly as its /v1 path, plus the deprecation headers",
  async (_name, c) => {
    const canonical = `/v1${c.legacy}`;
    const viaV1 = await call(c, canonical);
    const viaAlias = await call(c, c.legacy);
    expect(viaAlias.status).toBe(viaV1.status);
    expect(withoutRequestId(viaAlias.body)).toEqual(withoutRequestId(viaV1.body));
    expect(viaAlias.headers["cache-control"]).toBe("no-store");
    expectDeprecated(viaAlias.headers, canonical.split("?")[0]!);
    expectNotDeprecated(viaV1.headers);
  }
);

test("an unknown path under a legacy prefix is the same 404, naming the path the caller sent", async () => {
  const res = await request(http)
    .get("/testnet/mediator/no-such-route")
    .set("Authorization", `Bearer ${KEY}`)
    .set(freshIp());
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe("not_found");
  expect(res.body.error.message).toBe("Cannot GET /testnet/mediator/no-such-route");
  expectDeprecated(res.headers, "/v1/testnet/mediator/no-such-route");
});

test("a 401 on an alias carries the deprecation headers, no-store and the budget", async () => {
  const res = await request(http).get("/testnet/account/G").set(freshIp());
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe("unauthorized");
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["x-request-id"]).toBeString();
  expect(res.headers["ratelimit-limit"]).toBe(String(LIMIT));
  expectDeprecated(res.headers, "/v1/testnet/account/G");
});

test("a rejected body on an alias carries the deprecation headers", async () => {
  const res = await request(http)
    .post("/testnet/mediator/sign")
    .set("Authorization", `Bearer ${KEY}`)
    .set(freshIp())
    .set("Content-Type", "text/plain")
    .send("x");
  expect(res.status).toBe(415);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectDeprecated(res.headers, "/v1/testnet/mediator/sign");
});

test("an alias and its /v1 path spend one shared client budget, once per request, and the alias 429 keeps its headers", async () => {
  const caller = freshIp();
  for (let i = 0; i < LIMIT; i++) {
    const path = i % 2 === 0 ? "/testnet/account/G" : "/v1/testnet/account/G";
    const res = await request(http).get(path).set(caller);
    expect(res.headers["ratelimit-remaining"]).toBe(String(LIMIT - 1 - i));
  }
  const blocked = await request(http).get("/testnet/account/G").set(caller);
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe("rate_limited");
  expect(blocked.headers["cache-control"]).toBe("no-store");
  expect(blocked.headers["x-request-id"]).toBeString();
  expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  expectDeprecated(blocked.headers, "/v1/testnet/account/G");

  const canonical = await request(http).get("/v1/testnet/account/G").set(caller);
  expect(canonical.status).toBe(429);
  expectNotDeprecated(canonical.headers);
}, 30_000);

test("an alias and its /v1 path spend one shared key budget", async () => {
  const auth = { Authorization: `Bearer ${OTHER_KEY}` };
  for (let i = 0; i < LIMIT; i++) {
    const path = i % 2 === 0 ? "/config/exchange-registry" : "/v1/config/exchange-registry";
    const res = await request(http).get(path).set(auth).set(freshIp());
    expect(res.headers["ratelimit-remaining"]).toBe(String(LIMIT - 1 - i));
  }
  const blocked = await request(http).get("/v1/config/exchange-registry").set(auth).set(freshIp());
  expect(blocked.status).toBe(429);
  const alias = await request(http).get("/config/exchange-registry").set(auth).set(freshIp());
  expect(alias.status).toBe(429);
  expectDeprecated(alias.headers, "/v1/config/exchange-registry");
}, 30_000);

test("the access line names the /v1 route and flags the alias, never the raw path", async () => {
  written.length = 0;
  await request(http)
    .get("/config/exchange-registry")
    .set("Authorization", `Bearer ${KEY}`)
    .set(freshIp());
  await request(http)
    .get("/v1/config/exchange-registry")
    .set("Authorization", `Bearer ${KEY}`)
    .set(freshIp());
  const lines = written
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.message === "request");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ route: "/v1/config/exchange-registry", deprecatedAlias: true });
  expect(lines[1]!.route).toBe("/v1/config/exchange-registry");
  expect(lines[1]!.deprecatedAlias).toBeUndefined();
  expect(written.join("\n")).not.toContain('"/config/exchange-registry"');
});

test("operational and admin routes are not aliased", async () => {
  for (const path of ["/", "/health", "/admin/api-keys", "/v1/testnet/stats"]) {
    const res = await request(http).get(path).set(freshIp());
    expectNotDeprecated(res.headers);
  }
});

const UNVERSIONED = [/^\/$/, /^\/health(\/deep|\/dependencies)?$/, /^\/admin\/api-keys(\/.*)?$/];

test("every registered route outside the operational and admin allowlist is under /v1", () => {
  const router = (
    app.getHttpAdapter().getInstance() as {
      router: { stack: { route?: { path: string } }[] };
    }
  ).router;
  const paths = router.stack.flatMap((layer) => (layer.route ? [layer.route.path] : []));
  expect(paths.length).toBeGreaterThan(30);
  const unprefixed = paths.filter(
    (path) => !path.startsWith("/v1/") && !UNVERSIONED.some((allowed) => allowed.test(path))
  );
  expect(unprefixed).toEqual([]);
});
