import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";

const KEY = "e2e_test_key";
const LIMIT = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  delete process.env.INTEGRATOR_SESSION_SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

const ip = (address: string) => ({ "X-Forwarded-For": address });

function expectIdentified(res: request.Response): string {
  const id = res.headers["x-request-id"];
  expect(id).toMatch(UUID);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["ratelimit-limit"]).toBe(String(LIMIT));
  expect(res.headers["x-ratelimit-limit"]).toBe(String(LIMIT));
  expect(res.body.error.requestId).toBe(id);
  return id as string;
}

test("a 401 carries the request id in the header and the envelope, with no-store and the budget", async () => {
  const res = await request(http).get("/testnet/account/NOPE").set(ip("203.0.113.1"));
  expect(res.status).toBe(401);
  expect(res.body.error.message).toBe("A valid API key is required.");
  expectIdentified(res);
});

test("a 429 from the limiter carries the request id, no-store and the budget headers", async () => {
  const caller = ip("203.0.113.2");
  for (let i = 0; i < LIMIT; i++) await request(http).get("/testnet/account/G").set(caller);
  const blocked = await request(http).get("/testnet/account/G").set(caller);
  expect(blocked.status).toBe(429);
  expect(blocked.headers["retry-after"]).toBeDefined();
  expectIdentified(blocked);
}, 20_000);

test("404, a malformed body and an oversize body carry it too", async () => {
  const unknown = await request(http)
    .get("/no/such/route")
    .set(ip("203.0.113.3"))
    .set("Authorization", `Bearer ${KEY}`);
  expect(unknown.status).toBe(404);
  expectIdentified(unknown);

  const malformed = await request(http)
    .post("/v1/testnet/close/plan")
    .set(ip("203.0.113.4"))
    .set("Authorization", `Bearer ${KEY}`)
    .set("Content-Type", "application/json")
    .send("{not json");
  expect(malformed.status).toBe(400);
  expectIdentified(malformed);

  const oversize = await request(http)
    .post("/v1/testnet/close/plan")
    .set(ip("203.0.113.5"))
    .set("Authorization", `Bearer ${KEY}`)
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ pad: "x".repeat(200_000) }));
  expect(oversize.status).toBe(413);
  expectIdentified(oversize);
});

test("a controller error carries it, and a success carries the header without an envelope", async () => {
  const invalid = await request(http)
    .post("/v1/badnet/close/plan")
    .set(ip("203.0.113.6"))
    .set("Authorization", `Bearer ${KEY}`)
    .send({});
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe("invalid_network");
  expectIdentified(invalid);

  const ok = await request(http).get("/health").set(ip("203.0.113.7"));
  expect(ok.status).toBe(200);
  expect(ok.headers["x-request-id"]).toMatch(UUID);
  expect(ok.headers["cache-control"]).toBe("no-store");
  expect(ok.body.error).toBeUndefined();
});

test("every request gets its own id and a client-supplied one is ignored", async () => {
  const a = await request(http).get("/health").set("X-Request-Id", "client-chosen-id");
  const b = await request(http).get("/health");
  expect(a.headers["x-request-id"]).toMatch(UUID);
  expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  const c = await request(http)
    .get("/testnet/account/NOPE")
    .set(ip("203.0.113.8"))
    .set("X-Request-Id", "client-chosen-id");
  expect(c.body.error.requestId).toMatch(UUID);
  expect(c.headers["x-request-id"]).toBe(c.body.error.requestId);
});
