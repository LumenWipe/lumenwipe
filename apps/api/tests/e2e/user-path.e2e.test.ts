import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { AccountState, PlanResponse } from "@lumenwipe/types";
import { AppModule } from "@/app.module";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { USER_PATH_FIXTURE } from "@/health/user-path-probe";
import * as accountPlan from "@/lib/close-api/account-plan";
import * as accountState from "@/lib/stellar/account-state";
import { recordUpstream } from "@/lib/stellar/upstream-metrics";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { MeteringService } from "@/metering/metering.service";
import { InMemoryUsageStore, USAGE_STORE } from "@/metering/usage-store";

const KEY = "e2e_test_key";
// The probe discards what a step returns, so an empty value stands in for both.
const DISCARDED: unknown = {};

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
let usage: InMemoryUsageStore;
let analyze: ReturnType<typeof spyOn>;
let plan: ReturnType<typeof spyOn>;

beforeEach(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  analyze = spyOn(accountState, "getAccountState").mockResolvedValue(DISCARDED as AccountState);
  plan = spyOn(accountPlan, "buildAccountPlan").mockResolvedValue(DISCARDED as PlanResponse);
  usage = new InMemoryUsageStore();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(USAGE_STORE)
    .useValue(usage)
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger(() => undefined));
  await app.init();
  http = app.getHttpServer();
});

afterEach(async () => {
  await app.close();
  mock.restore();
});

test("analyze broken: the user path answers 503 while /health still answers 200", async () => {
  analyze.mockImplementation(async () => {
    recordUpstream("mainnet", "horizon", "requests");
    throw new UpstreamError("unavailable", "horizon", "https://horizon.example.test/key-abc123");
  });

  const probe = await request(http).get("/health/user-path");
  expect(probe.status).toBe(503);
  expect(probe.body).toEqual({
    status: "failed",
    network: "mainnet",
    checkedAt: expect.any(String),
    steps: [
      { step: "analyze", result: "failed", errorClass: "upstream", latencyMs: expect.any(Number) },
      { step: "plan", result: "ok", errorClass: null, latencyMs: expect.any(Number) },
    ],
  });
  expect(probe.text).not.toContain("example");

  const liveness = await request(http).get("/health");
  expect(liveness.status).toBe(200);
  expect(liveness.body.status).toBe("ok");
});

test("both steps passing answers 200 through the code the keyed routes run", async () => {
  const res = await request(http).get("/health/user-path");
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("ok");

  const { source, destination } = USER_PATH_FIXTURE;
  expect(analyze.mock.calls).toEqual([
    [source, "mainnet", { manualTokenCandidates: [], scanTokenEvents: true }],
  ]);
  expect(plan.mock.calls).toHaveLength(1);
  expect(plan.mock.calls[0]!.slice(0, 4)).toEqual([
    source,
    destination,
    [{ id: `destination:${destination}`, choice: "i_control_this_address" }],
    "mainnet",
  ]);
});

test("polling starts one run, is not throttled, and is never metered, with or without a key", async () => {
  const metered = spyOn(MeteringService.prototype, "record");
  const responses = await Promise.all([
    ...Array.from({ length: 20 }, () => request(http).get("/health/user-path")),
    request(http).get("/health/user-path").set("Authorization", `Bearer ${KEY}`),
  ]);
  for (const res of responses) {
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
  }
  expect(analyze.mock.calls).toHaveLength(1);
  expect(plan.mock.calls).toHaveLength(1);
  expect(metered).not.toHaveBeenCalled();
});

test("a run writes its own upstream counts to the store before it answers", async () => {
  analyze.mockImplementation(async () => {
    recordUpstream("mainnet", "horizon", "requests");
    return DISCARDED as AccountState;
  });
  await request(http).get("/health/user-path");
  const day = new Date().toISOString().slice(0, 10);
  expect(usage.upstream.get(`${day}/mainnet/horizon/requests`)).toBe(1);
});

test("a missing fixture answers 200 and says so", async () => {
  analyze.mockRejectedValue(new AccountNotFoundError(USER_PATH_FIXTURE.source));
  plan.mockRejectedValue(new AccountNotFoundError(USER_PATH_FIXTURE.source));
  const res = await request(http).get("/health/user-path");
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("fixture_missing");
});
