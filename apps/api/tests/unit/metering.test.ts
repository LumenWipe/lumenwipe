import { describe, expect, test } from "bun:test";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import type { AuthedRequest } from "@/auth/api-key.guard";
import { MeteringInterceptor, meteredRoute } from "@/metering/metering.interceptor";
import { MeteringService, RECORD_TIMEOUT_MS } from "@/metering/metering.service";
import type { Firestore } from "@google-cloud/firestore";
import {
  FirestoreUsageStore,
  InMemoryUsageStore,
  ownerDocId,
  type UsageStore,
} from "@/metering/usage-store";

const OWNER = "GOWNER";
const KEY_ID = "d".repeat(64);

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
      addUpstreamCounts: async () => {},
      addRateLimited: async () => {},
    };
    await expect(service(store).metering.record(OWNER, "r")).resolves.toBeUndefined();
  });

  test("a hung store write gives up after the timeout", async () => {
    const store: UsageStore = {
      increment: () => new Promise(() => {}),
      daily: async () => [],
      addUpstreamCounts: async () => {},
      addRateLimited: async () => {},
    };
    const started = Date.now();
    await service(store).metering.record(OWNER, "r");
    expect(Date.now() - started).toBeLessThan(RECORD_TIMEOUT_MS + 500);
  });

  test("usage is null when the store cannot be read", async () => {
    const store: UsageStore = {
      increment: async () => {},
      daily: () => Promise.reject(new Error("firestore down")),
      addUpstreamCounts: async () => {},
      addRateLimited: async () => {},
    };
    expect(await service(store).metering.usage(OWNER)).toBeNull();
  });
});

describe("per-key usage", () => {
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);

  test("splits the owner's requests by key, today and over the window, and keeps 429s apart", async () => {
    const { metering, store, clock } = service();
    clock.now = new Date("2026-09-09T12:00:00Z");
    await metering.record(OWNER, "r", KEY_A);
    clock.now = new Date("2026-10-01T12:00:00Z");
    await metering.record(OWNER, "r", KEY_A);
    await metering.record(OWNER, "r", KEY_B);
    clock.now = new Date("2026-10-09T12:00:00Z");
    await metering.record(OWNER, "r", KEY_A);
    await metering.record(OWNER, "r");
    await store.addRateLimited([{ owner: OWNER, keyId: KEY_B, date: "2026-10-09", count: 7 }]);

    expect(await metering.report(OWNER)).toEqual({
      owner: { today: 2, last30Days: 4 },
      byKey: {
        [KEY_A]: { today: 1, last30Days: 2, rateLimitedLast30Days: 0 },
        [KEY_B]: { today: 0, last30Days: 1, rateLimitedLast30Days: 7 },
      },
    });
    expect(await metering.usage(OWNER)).toEqual({ today: 2, last30Days: 4 });
  });

  test("a day with only 429s adds nothing to the owner's requests", async () => {
    const { metering, store } = service();
    await store.addRateLimited([{ owner: OWNER, keyId: KEY_A, date: "2026-10-09", count: 3 }]);
    expect(await metering.usage(OWNER)).toEqual({ today: 0, last30Days: 0 });
  });

  test("an id without the key id shape is never counted per key", async () => {
    const { metering, store } = service();
    await metering.record(OWNER, "r", "a.b");
    await store.addRateLimited([{ owner: OWNER, keyId: "x/y", date: "2026-10-09", count: 1 }]);
    expect(await metering.report(OWNER)).toEqual({
      owner: { today: 1, last30Days: 1 },
      byKey: {},
    });
  });

  test("the interceptor passes the request's key id", async () => {
    const { metering } = service();
    await intercept(metering, request({ apiKeyId: KEY_A }), {});
    expect((await metering.report(OWNER))?.byKey[KEY_A]?.today).toBe(1);
  });
});

describe("FirestoreUsageStore per-key fields", () => {
  test("counts a key in the request's own write and refuses an unsafe id as a field name", async () => {
    const writes: Record<string, unknown>[] = [];
    const days = {
      doc: () => ({ set: async (data: Record<string, unknown>) => writes.push(data) }),
    };
    const firestore = {
      collection: () => ({ doc: () => ({ collection: () => days }) }),
    } as unknown as Firestore;
    const store = new FirestoreUsageStore(firestore);
    await store.increment(OWNER, "r", "2026-10-09", KEY_ID);
    await store.increment(OWNER, "r", "2026-10-09", "a.b.c");
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes[0]!.byKey as object)).toEqual([KEY_ID]);
    expect(writes[1]!.byKey).toBeUndefined();
  });

  test("adds 429s in one batch without touching total, skipping unsafe ids", async () => {
    const sets: Record<string, unknown>[] = [];
    let commits = 0;
    const firestore = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }),
      batch: () => ({
        set: (_ref: unknown, data: Record<string, unknown>) => sets.push(data),
        commit: async () => {
          commits++;
        },
      }),
    } as unknown as Firestore;
    await new FirestoreUsageStore(firestore).addRateLimited([
      { owner: OWNER, keyId: KEY_ID, date: "2026-10-09", count: 4 },
      { owner: OWNER, keyId: "a.b", date: "2026-10-09", count: 1 },
    ]);
    expect(commits).toBe(1);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.total).toBeUndefined();
    expect(Object.keys(sets[0]!.rateLimitedByKey as object)).toEqual([KEY_ID]);
  });

  test("reads a day that has only 429s as zero requests", async () => {
    const doc = (fields: Record<string, unknown>) => ({ get: (f: string) => fields[f] });
    const firestore = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            where: () => ({
              get: async () => ({
                docs: [doc({ date: "2026-10-09", rateLimitedByKey: { [KEY_ID]: 2 } })],
              }),
            }),
          }),
        }),
      }),
    } as unknown as Firestore;
    expect(await new FirestoreUsageStore(firestore).daily(OWNER, "2026-10-01")).toEqual([
      { date: "2026-10-09", total: 0, rateLimitedByKey: { [KEY_ID]: 2 } },
    ]);
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
      addUpstreamCounts: async () => {},
      addRateLimited: async () => {},
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
      addUpstreamCounts: async () => {},
      addRateLimited: async () => {},
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
