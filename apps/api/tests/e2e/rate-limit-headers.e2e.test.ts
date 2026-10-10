import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { RateLimiter } from "@/auth/rate-limiter";
import { configureApp } from "@/configure-app";

const KEY = "e2e_test_key";
const LIMIT = 120;

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

function expectBudget(headers: Record<string, string>, remaining?: number): void {
  expect(headers["ratelimit-limit"]).toBe(String(LIMIT));
  expect(Number(headers["ratelimit-reset"])).toBeGreaterThan(0);
  if (remaining !== undefined) expect(headers["ratelimit-remaining"]).toBe(String(remaining));
  expect(headers["x-ratelimit-limit"]).toBe(headers["ratelimit-limit"]);
  expect(headers["x-ratelimit-remaining"]).toBe(headers["ratelimit-remaining"]);
  expect(headers["x-ratelimit-reset"]).toBe(headers["ratelimit-reset"]);
}

test("a successful response carries the three RateLimit headers, counting down", async () => {
  const first = await request(http)
    .get("/config/exchange-registry")
    .set("Authorization", `Bearer ${KEY}`);
  expect(first.status).toBe(200);
  expectBudget(first.headers, LIMIT - 1);
  const second = await request(http)
    .get("/config/exchange-registry")
    .set("Authorization", `Bearer ${KEY}`);
  expect(second.headers["ratelimit-remaining"]).toBe(String(LIMIT - 2));
});

test("error responses, unknown routes and rejected bodies carry them too", async () => {
  const unauthorized = await request(http).get("/testnet/account/G").set(ip("198.51.100.1"));
  expect(unauthorized.status).toBe(401);
  expectBudget(unauthorized.headers, LIMIT - 1);

  const unknown = await request(http).get("/no/such/route").set(ip("198.51.100.2"));
  expect(unknown.status).toBe(404);
  expectBudget(unknown.headers, LIMIT - 1);

  const malformed = await request(http)
    .post("/v1/testnet/close/plan")
    .set(ip("198.51.100.3"))
    .set("Content-Type", "application/json")
    .send("{not json");
  expect(malformed.status).toBe(400);
  expectBudget(malformed.headers, LIMIT - 1);

  const oversize = await request(http)
    .post("/v1/testnet/close/plan")
    .set(ip("198.51.100.4"))
    .send({ pad: "x".repeat(200_000) });
  expect(oversize.status).toBe(413);
  expectBudget(oversize.headers, LIMIT - 1);

  const media = await request(http)
    .post("/v1/testnet/close/plan")
    .set(ip("198.51.100.5"))
    .set("Content-Type", "text/plain")
    .send("hello");
  expect(media.status).toBe(415);
  expectBudget(media.headers, LIMIT - 1);
});

test("a 503 carries Retry-After", async () => {
  const res = await request(http)
    .post("/integrator/auth/challenge")
    .set(ip("198.51.100.6"))
    .send({});
  expect(res.status).toBe(503);
  expect(res.headers["retry-after"]).toBe("30");
  expectBudget(res.headers);
});

test("the service index and the health checks are not counted and send no budget headers", async () => {
  for (const path of ["/", "/health"]) {
    const res = await request(http).get(path).set(ip("198.51.100.7"));
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  }
  const next = await request(http).get("/no/such/route").set(ip("198.51.100.7"));
  expect(next.headers["ratelimit-remaining"]).toBe(String(LIMIT - 1));
});

test("an exhausted budget answers 429 with Retry-After before the body is read or the key is checked", async () => {
  const caller = ip("198.51.100.8");
  for (let i = 0; i < LIMIT; i++) await request(http).get("/testnet/account/G").set(caller);

  const blocked = await request(http).get("/testnet/account/G").set(caller);
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe("rate_limited");
  expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  expect(blocked.headers["ratelimit-remaining"]).toBe("0");
  expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
  expectBudget(blocked.headers, 0);

  const malformed = await request(http)
    .post("/v1/testnet/close/plan")
    .set(caller)
    .set("Content-Type", "application/json")
    .send("{not json");
  expect(malformed.status).toBe(429);
  const unknown = await request(http).get("/no/such/route").set(caller);
  expect(unknown.status).toBe(429);
}, 20_000);

test("a 429 is the same whether the key is valid or not", async () => {
  const bodies: unknown[] = [];
  for (const key of [KEY, "not_a_real_key"]) {
    for (let i = 0; i < LIMIT; i++) {
      await request(http).get("/testnet/account/G").set("Authorization", `Bearer ${key}`);
    }
    const res = await request(http).get("/testnet/account/G").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(429);
    bodies.push(res.body);
  }
  expect(bodies[0]).toEqual(bodies[1]);
}, 30_000);

test("every response the limiter or the body handling sends is non-cacheable", async () => {
  const caller = ip("198.51.100.20");
  const ok = await request(http).get("/no/such/route").set(caller);
  expect(ok.status).toBe(404);
  expect(ok.headers["cache-control"]).toBe("no-store");

  const bodyErrors = [
    await request(http)
      .post("/v1/testnet/close/plan")
      .set(caller)
      .set("Content-Type", "application/json")
      .send("{not json"),
    await request(http)
      .post("/v1/testnet/close/plan")
      .set(caller)
      .send({ pad: "x".repeat(200_000) }),
    await request(http)
      .post("/v1/testnet/close/plan")
      .set(caller)
      .set("Content-Type", "text/plain")
      .send("hello"),
  ];
  expect(bodyErrors.map((r) => r.status)).toEqual([400, 413, 415]);
  for (const res of bodyErrors) expect(res.headers["cache-control"]).toBe("no-store");

  const exhausted = ip("198.51.100.21");
  for (let i = 0; i < LIMIT; i++) await request(http).get("/no/such/route").set(exhausted);
  const blocked = await request(http).get("/no/such/route").set(exhausted);
  expect(blocked.status).toBe(429);
  expect(blocked.headers["cache-control"]).toBe("no-store");
}, 20_000);

test("unthrottled paths are non-cacheable and carry no RateLimit headers", async () => {
  for (const path of ["/", "/health"]) {
    const res = await request(http).get(path).set(ip("198.51.100.22"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  }
});

test("a limiter failure answers 500 and is non-cacheable", async () => {
  const failing = spyOn(RateLimiter.prototype, "consume").mockRejectedValue(
    new Error("store down")
  );
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const broken = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(broken);
    await broken.init();
    const res = await request(broken.getHttpServer()).get("/no/such/route");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(res.headers["cache-control"]).toBe("no-store");
    await broken.close();
  } finally {
    failing.mockRestore();
  }
});
