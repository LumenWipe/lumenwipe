import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";

// Coverage for #59: a request with no API key (or a wrong one) used to be rejected with 401
// BEFORE the throttler ever ran (ApiKeyGuard was registered ahead of ApiKeyThrottlerGuard), so
// an unauthenticated flood was entirely unthrottled at the app layer - each 401 still cost a
// full guard evaluation, with no budget capping how often that could happen. Guards now run
// throttler-first.
//
// Uses the real default THROTTLE_LIMIT (120/60s, app.module.ts) rather than an env override:
// AppModule's ThrottlerModule.forRoot() reads THROTTLE_LIMIT/THROTTLE_TTL inside its own
// @Module() decorator argument, evaluated once at import time - by the time any beforeAll here
// could set the env var, the module's options are already fixed (the same class of pitfall
// CLAUDE.md documents for config/networks.ts). 121 in-process supertest calls with no real
// network cost is fast enough not to need a lower limit.
const THROTTLE_LIMIT = 120;

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  process.env.API_KEYS = "test=real_key_unused_here";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

test("an unauthenticated flood eventually gets 429, not endless 401s", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < THROTTLE_LIMIT + 2; i++) {
    const res = await request(http)
      .get("/testnet/account/GABC")
      .set("X-Forwarded-For", "203.0.113.9");
    statuses.push(res.status);
  }

  // The first THROTTLE_LIMIT requests are each rejected on their own merits (401, no key) - the
  // point under test is that further requests from the SAME tracked caller start getting capped
  // at all, which never happened before this fix (ApiKeyGuard's 401 short-circuited every
  // request ahead of the throttler).
  expect(statuses.slice(0, THROTTLE_LIMIT).every((s) => s === 401)).toBe(true);
  expect(statuses.slice(THROTTLE_LIMIT)).toEqual([429, 429]);
}, 20_000);

test("trust proxy is honored: X-Forwarded-For, not the raw socket address, is the tracked IP", async () => {
  // If trust proxy were off, every request in this whole file would collapse onto the same
  // "IP" (the test client's real loopback socket address) regardless of X-Forwarded-For, and
  // this caller would already be throttled by the previous test's budget. This asserts trust
  // proxy is honored directly: a fresh X-Forwarded-For value gets its own fresh budget.
  const fresh = await request(http)
    .get("/testnet/account/GABC")
    .set("X-Forwarded-For", "203.0.113.21");
  expect(fresh.status).toBe(401);
});
