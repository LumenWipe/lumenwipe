import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpException, Logger } from "@nestjs/common";
import {
  currentDeadline,
  currentProviderPins,
  currentUpstreamCalls,
} from "@/common/request-context";
import {
  USER_PATH_FAILED_TTL_MS,
  USER_PATH_FIXTURE,
  USER_PATH_FIXTURE_MISSING_MESSAGE,
  USER_PATH_OK_TTL_MS,
  USER_PATH_STEP_BUDGET_MS,
  UserPathProbe,
  type UserPathStepRuns,
} from "@/health/user-path-probe";
import { drainUpstreamCounts, recordUpstream } from "@/lib/stellar/upstream-metrics";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { RECORD_TIMEOUT_MS } from "@/metering/metering.service";
import { inRequestContext } from "../support/request-context";

const ok = (): Promise<unknown> => Promise.resolve({});
const failing = (error: unknown) => (): Promise<unknown> => Promise.reject(error);
const httpError = (status: number): HttpException =>
  new HttpException({ error: { code: "x", message: "y" } }, status);

function steps(overrides: Partial<UserPathStepRuns> = {}): UserPathStepRuns {
  return { analyze: ok, plan: ok, ...overrides };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  mock.restore();
  drainUpstreamCounts();
});

test("both steps passing is ok, with fixed values only", async () => {
  const verdict = await new UserPathProbe(steps(), { now: () => 1_000 }).verdict();
  expect(verdict).toEqual({
    status: "ok",
    network: "mainnet",
    checkedAt: new Date(1_000).toISOString(),
    steps: [
      { step: "analyze", result: "ok", errorClass: null, latencyMs: 0 },
      { step: "plan", result: "ok", errorClass: null, latencyMs: 0 },
    ],
  });
});

test("a hundred concurrent callers share one run, and none starts inside the TTL", async () => {
  let runs = 0;
  let now = 0;
  const probe = new UserPathProbe(
    steps({
      analyze: async () => {
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    }),
    { now: () => now }
  );
  const verdicts = await Promise.all(Array.from({ length: 100 }, () => probe.verdict()));
  expect(runs).toBe(1);
  expect(new Set(verdicts).size).toBe(1);

  now += USER_PATH_OK_TTL_MS - 1;
  await probe.verdict();
  expect(runs).toBe(1);
  now += 1;
  await probe.verdict();
  expect(runs).toBe(2);
});

test("a failed verdict is served for 60 seconds, then the next caller runs again", async () => {
  let runs = 0;
  let now = 0;
  const probe = new UserPathProbe(
    steps({
      plan: () => {
        runs++;
        return Promise.reject(new UpstreamError("unavailable", "horizon"));
      },
    }),
    { now: () => now }
  );
  expect((await probe.verdict()).status).toBe("failed");
  now += USER_PATH_FAILED_TTL_MS - 1;
  await probe.verdict();
  expect(runs).toBe(1);
  now += 1;
  await probe.verdict();
  expect(runs).toBe(2);
  expect(USER_PATH_FAILED_TTL_MS).toBe(60_000);
  expect(USER_PATH_OK_TTL_MS).toBe(300_000);
});

test.each([
  ["a 503 from the analysis", "analyze", httpError(503), "upstream"],
  ["a 502 from the analysis", "analyze", httpError(502), "upstream"],
  ["a 409 from the analysis", "analyze", httpError(409), "upstream"],
  ["a 500 from the analysis", "analyze", httpError(500), "internal"],
  ["a provider outage in the plan", "plan", new UpstreamError("unavailable", "rpc"), "upstream"],
  ["a bug in the plan", "plan", new TypeError("x is not a function"), "internal"],
  ["a 500 from the plan", "plan", httpError(500), "internal"],
] as const)("%s fails the verdict as %s", async (_, step, error, errorClass) => {
  const verdict = await new UserPathProbe(steps({ [step]: failing(error) })).verdict();
  expect(verdict.status).toBe("failed");
  expect(verdict.steps.find((s) => s.step === step)).toMatchObject({
    result: "failed",
    errorClass,
  });
  expect(verdict.steps.find((s) => s.step !== step)).toMatchObject({ result: "ok" });
});

test("a missing fixture is not a failure, and logs the fixed message at error severity", async () => {
  const errors = spyOn(Logger.prototype, "error");
  const verdict = await new UserPathProbe(
    steps({
      analyze: failing(httpError(404)),
      plan: failing(new AccountNotFoundError(USER_PATH_FIXTURE.source)),
    })
  ).verdict();
  expect(verdict.status).toBe("fixture_missing");
  expect(verdict.steps.map((s) => s.errorClass)).toEqual(["fixture_missing", "fixture_missing"]);
  expect(errors.mock.calls).toEqual([
    [{ message: USER_PATH_FIXTURE_MISSING_MESSAGE, network: "mainnet" }],
  ]);
  expect(USER_PATH_FIXTURE_MISSING_MESSAGE).toBe("user-path probe fixture account not found");
});

test("a missing fixture does not hide a real failure of the other step", async () => {
  const verdict = await new UserPathProbe(
    steps({ analyze: failing(httpError(404)), plan: failing(httpError(503)) })
  ).verdict();
  expect(verdict.status).toBe("failed");
});

test("a step that never answers is abandoned at its budget, and its deadline has expired", async () => {
  let signal: AbortSignal | undefined;
  const probe = new UserPathProbe(
    steps({
      analyze: () => {
        signal = currentDeadline()?.signal;
        return new Promise(() => undefined);
      },
    }),
    { stepBudgetMs: 30 }
  );
  const startedAt = Date.now();
  const verdict = await probe.verdict();
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(verdict.status).toBe("failed");
  expect(verdict.steps[0]).toMatchObject({ result: "failed", errorClass: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(signal?.aborted).toBe(true);
});

test("no text of an upstream failure reaches the body", async () => {
  const secret = "https://rpc.example.test/v2/key-abc123";
  const verdict = await new UserPathProbe(
    steps({
      analyze: failing(new HttpException({ error: { code: "x", message: secret } }, 503)),
      plan: failing(new UpstreamError("unavailable", secret, secret)),
    })
  ).verdict();
  const body = JSON.stringify(verdict);
  expect(body).not.toContain("example");
  expect(body).not.toContain("key-abc123");
  expect(Object.keys(verdict).sort()).toEqual(["checkedAt", "network", "status", "steps"]);
  for (const step of verdict.steps) {
    expect(Object.keys(step).sort()).toEqual(["errorClass", "latencyMs", "result", "step"]);
  }
});

test("each step runs in a context of its own, not the calling request's", async () => {
  const seen: Array<{ deadline: unknown; pins: unknown }> = [];
  const record = async (): Promise<void> => {
    seen.push({ deadline: currentDeadline(), pins: currentProviderPins() });
    currentProviderPins()?.set("rpc:mainnet", "pinned by the probe");
    recordUpstream("mainnet", "rpc", "requests");
  };
  const probe = new UserPathProbe({ analyze: record, plan: record }, { stepBudgetMs: 5_000 });
  await inRequestContext(async () => {
    const caller = { deadline: currentDeadline(), pins: currentProviderPins() };
    await probe.verdict();
    expect(seen).toHaveLength(2);
    for (const step of seen) {
      expect(step.deadline).toBeDefined();
      expect(step.deadline).not.toBe(caller.deadline);
      expect(step.pins).not.toBe(caller.pins);
    }
    expect(seen[0]!.pins).not.toBe(seen[1]!.pins);
    expect(caller.pins?.size).toBe(0);
    expect(currentUpstreamCalls()?.size).toBe(0);
  }, 40_000);
});

test("the run waits for its flush before answering, and a failed flush does not fail it", async () => {
  const order: string[] = [];
  const probe = new UserPathProbe(
    steps({
      plan: async () => {
        order.push("plan");
      },
    }),
    {
      afterRun: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("flush");
        throw new Error("store down");
      },
    }
  );
  const verdict = await probe.verdict();
  order.push("answered");
  expect(order).toEqual(["plan", "flush", "answered"]);
  expect(verdict.status).toBe("ok");
});

test("the fixture is the latency lab's mainnet baseline and its destination", () => {
  const lab = readFileSync(
    new URL("../../../../tools/lab/src/scenarios.ts", import.meta.url),
    "utf8"
  );
  const mainnet = lab.slice(lab.indexOf("mainnet: {"), lab.indexOf("testnet: {"));
  expect(mainnet).toContain(`baseline: "${USER_PATH_FIXTURE.source}"`);
  expect(mainnet).toContain(`token: "${USER_PATH_FIXTURE.destination}"`);
  expect(lab).toContain("destination: f.token");
});

test("the steps and the flush that follows fit the 24 seconds the route is documented to answer in", () => {
  expect(USER_PATH_STEP_BUDGET_MS).toBe(20_000);
  expect(USER_PATH_STEP_BUDGET_MS + 2 * RECORD_TIMEOUT_MS).toBeLessThan(24_000);
});
