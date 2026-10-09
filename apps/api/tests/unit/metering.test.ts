import { describe, expect, test } from "bun:test";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import type { AuthedRequest } from "@/auth/api-key.guard";
import { MeteringInterceptor, meteredRoute } from "@/metering/metering.interceptor";
import { MeteringService, RECORD_TIMEOUT_MS } from "@/metering/metering.service";
import { InMemoryUsageStore, ownerDocId, type UsageStore } from "@/metering/usage-store";

const OWNER = "GOWNER";

function service(store: UsageStore = new InMemoryUsageStore(), at = "2026-10-09T12:00:00Z") {
  const clock = { now: new Date(at) };
  return { metering: new MeteringService(store, () => clock.now), store, clock };
}

function request(overrides: Partial<AuthedRequest> = {}): AuthedRequest {
  return {
    method: "POST",
    route: { path: "/v1/:network/submit" },
    params: { network: "mainnet" },
    apiKeyLabel: OWNER,
    ...overrides,
  } as unknown as AuthedRequest;
}

function intercept(metering: MeteringService, req: AuthedRequest, body: unknown) {
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(body) };
  return firstValueFrom(new MeteringInterceptor(metering).intercept(context, next));
}

describe("MeteringService", () => {
  test("counts survive a new service instance over the same store", async () => {
    const store = new InMemoryUsageStore();
    const first = service(store).metering;
    await first.record(OWNER, "POST /v1/mainnet/submit");
    await first.record(OWNER, "GET /v1/mainnet/account/:address");
    const restarted = service(store).metering;
    expect(await restarted.usage(OWNER)).toEqual({ today: 2, last30Days: 2 });
  });

  test("buckets by UTC day and sums only the last 30 days, today included", async () => {
    const { metering, clock } = service();
    clock.now = new Date("2026-09-09T23:59:59Z");
    await metering.record(OWNER, "r");
    clock.now = new Date("2026-09-10T00:00:00Z");
    await metering.record(OWNER, "r");
    clock.now = new Date("2026-10-08T10:00:00Z");
    await metering.record(OWNER, "r");
    clock.now = new Date("2026-10-09T12:00:00Z");
    await metering.record(OWNER, "r");
    expect(await metering.usage(OWNER)).toEqual({ today: 1, last30Days: 3 });
  });

  test("keeps owners apart", async () => {
    const { metering } = service();
    await metering.record(OWNER, "r");
    expect(await metering.usage("GOTHER")).toEqual({ today: 0, last30Days: 0 });
  });

  test("a failing store write never throws", async () => {
    const store: UsageStore = {
      increment: () => Promise.reject(new Error("firestore down")),
      daily: async () => [],
    };
    await expect(service(store).metering.record(OWNER, "r")).resolves.toBeUndefined();
  });

  test("a hung store write gives up after the timeout", async () => {
    const store: UsageStore = { increment: () => new Promise(() => {}), daily: async () => [] };
    const started = Date.now();
    await service(store).metering.record(OWNER, "r");
    expect(Date.now() - started).toBeLessThan(RECORD_TIMEOUT_MS + 500);
  });

  test("usage is null when the store cannot be read", async () => {
    const store: UsageStore = {
      increment: async () => {},
      daily: () => Promise.reject(new Error("firestore down")),
    };
    expect(await service(store).metering.usage(OWNER)).toBeNull();
  });
});

describe("MeteringInterceptor", () => {
  test("records the write before the response body is emitted", async () => {
    const order: string[] = [];
    const store: UsageStore = {
      increment: async () => {
        await Promise.resolve();
        order.push("recorded");
      },
      daily: async () => [],
    };
    const body = await intercept(service(store).metering, request(), { ok: true });
    order.push("emitted");
    expect(body).toEqual({ ok: true });
    expect(order).toEqual(["recorded", "emitted"]);
  });

  test("a failing write leaves the response untouched", async () => {
    const store: UsageStore = {
      increment: () => Promise.reject(new Error("firestore down")),
      daily: async () => [],
    };
    expect(await intercept(service(store).metering, request(), { ok: true })).toEqual({
      ok: true,
    });
  });

  test("does not meter a request without an API key", async () => {
    const { metering } = service();
    await intercept(metering, request({ apiKeyLabel: undefined }), {});
    expect(await metering.usage(OWNER)).toEqual({ today: 0, last30Days: 0 });
  });
});

describe("meteredRoute", () => {
  test("names the route pattern with the network filled in", () => {
    expect(meteredRoute(request())).toBe("POST /v1/mainnet/submit");
    expect(
      meteredRoute(request({ method: "GET", route: { path: "/v1/health" }, params: {} }))
    ).toBe("GET /v1/health");
  });
});

describe("ownerDocId", () => {
  test("leaves wallet addresses readable and escapes what a document id cannot hold", () => {
    expect(ownerDocId("GABC123")).toBe("GABC123");
    expect(ownerDocId("team/a")).toBe("team%2Fa");
    expect(ownerDocId("..")).toBe("%2E%2E");
    expect(ownerDocId("__x__")).toBe("%5F%5Fx%5F%5F");
  });
});
