import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { RateLimiter } from "@/auth/rate-limiter";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { createOpenApiDocument } from "@/openapi";

const KEY = "e2e_security_headers_key";
const LIMIT = 120;
const HSTS = "max-age=63072000; includeSubDomains";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const created = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(created, new JsonLogger(() => undefined));
  SwaggerModule.setup("docs", created, createOpenApiDocument(created));
  await created.init();
  return created;
}

beforeAll(async () => {
  process.env.API_KEYS = `security=${KEY}`;
  delete process.env.INTEGRATOR_SESSION_SECRET;
  app = await createApp();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

let nextHost = 1;
const freshIp = (): { "X-Forwarded-For": string } => ({
  "X-Forwarded-For": `198.18.11.${nextHost++}`,
});

function expectSecurityHeaders(res: request.Response, name: string): void {
  expect(res.headers["strict-transport-security"], name).toBe(HSTS);
}

const auth = { Authorization: `Bearer ${KEY}` };
const PLAN = "/v1/testnet/close/plan";
const CASES: Array<[string, () => request.Test, number]> = [
  ["index", () => request(http).get("/"), 200],
  ["health", () => request(http).get("/health"), 200],
  ["openapi", () => request(http).get("/docs-json"), 200],
  ["head", () => request(http).head("/health"), 200],
  ["keyed", () => request(http).get("/v1/config/exchange-registry").set(auth), 200],
  ["no key", () => request(http).get("/v1/testnet/account/G"), 401],
  ["unknown route", () => request(http).get("/no/such/route"), 404],
  [
    "preflight",
    () =>
      request(http)
        .options(PLAN)
        .set("Origin", "https://example.com")
        .set("Access-Control-Request-Method", "POST"),
    404,
  ],
  [
    "malformed body",
    () =>
      request(http).post(PLAN).set(auth).set("Content-Type", "application/json").send("{not json"),
    400,
  ],
  [
    "oversized body",
    () =>
      request(http)
        .post(PLAN)
        .set(auth)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ pad: "x".repeat(200_000) })),
    413,
  ],
  [
    "non-JSON body",
    () => request(http).post(PLAN).set(auth).set("Content-Type", "text/plain").send("hello"),
    415,
  ],
];

test.each(CASES)("%s carries the headers", async (name, send, status) => {
  const res = await send().set(freshIp());
  expect(res.status).toBe(status);
  expectSecurityHeaders(res, name);
});

test("a kill-switch 503 carries the headers", async () => {
  const saved = process.env.FEE_SPONSORSHIP_ENABLED;
  try {
    process.env.FEE_SPONSORSHIP_ENABLED = "false";
    const res = await request(http)
      .post("/v1/testnet/fee-bump/sponsor")
      .set("Authorization", `Bearer ${KEY}`)
      .set(freshIp())
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("fee_sponsorship_paused");
    expectSecurityHeaders(res, "kill switch");
  } finally {
    if (saved === undefined) delete process.env.FEE_SPONSORSHIP_ENABLED;
    else process.env.FEE_SPONSORSHIP_ENABLED = saved;
  }
});

test("the rate limiter's 429 carries the headers", async () => {
  const caller = freshIp();
  for (let i = 0; i < LIMIT; i++) await request(http).get("/no/such/route").set(caller);
  const blocked = await request(http).get("/no/such/route").set(caller);
  expect(blocked.status).toBe(429);
  expectSecurityHeaders(blocked, "429");
}, 20_000);

test("a limiter failure's 500 carries the headers", async () => {
  const failing = spyOn(RateLimiter.prototype, "consume").mockRejectedValue(
    new Error("store down")
  );
  try {
    const broken = await createApp();
    const res = await request(broken.getHttpServer()).get("/no/such/route");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expectSecurityHeaders(res, "limiter failure");
    await broken.close();
  } finally {
    failing.mockRestore();
  }
});
