import { describe, expect, test } from "bun:test";
import { InMemoryApiKeyStore } from "@/auth/api-key-store";
import {
  KEY_ACTIVITY_FLUSH_INTERVAL_MS,
  KeyActivityService,
} from "@/metering/key-activity.service";

function setup() {
  let now = Date.parse("2026-11-08T12:00:00Z");
  const store = new InMemoryApiKeyStore();
  const writes: Map<string, Date>[] = [];
  const recordLastUsed = store.recordLastUsed.bind(store);
  let failNext = false;
  store.recordLastUsed = async (entries) => {
    writes.push(new Map(entries));
    if (failNext) {
      failNext = false;
      throw new Error("unavailable");
    }
    return recordLastUsed(entries);
  };
  const service = new KeyActivityService(store, () => new Date(now));
  return {
    store,
    service,
    writes,
    advance: (ms: number) => (now += ms),
    failNextWrite: () => (failNext = true),
  };
}

describe("KeyActivityService", () => {
  test("many requests inside one interval cost one write, made only once it is due", async () => {
    const { store, service, writes, advance } = setup();
    const { record } = await store.create("GOWNER");
    for (let i = 0; i < 50; i++) {
      service.touch(record.hash);
      await service.flushIfDue();
      advance(1_000);
    }
    expect(writes).toHaveLength(0);
    advance(KEY_ACTIVITY_FLUSH_INTERVAL_MS);
    await service.flushIfDue();
    expect(writes).toHaveLength(1);
    expect((await store.findByHash(record.hash))!.lastUsedAt).toEqual(writes[0]!.get(record.hash)!);
  });

  test("keeps the latest use of each key and writes nothing when no key was used", async () => {
    const { store, service, writes, advance } = setup();
    const a = (await store.create("GOWNER")).record.hash;
    const b = (await store.create("GOWNER")).record.hash;
    service.touch(a);
    advance(5_000);
    service.touch(b);
    service.touch(a);
    advance(KEY_ACTIVITY_FLUSH_INTERVAL_MS);
    await service.flushIfDue();
    expect([...writes[0]!.keys()].sort()).toEqual([a, b].sort());
    expect(writes[0]!.get(a)!.getTime()).toBe(writes[0]!.get(b)!.getTime());
    advance(KEY_ACTIVITY_FLUSH_INTERVAL_MS);
    await service.flushIfDue();
    expect(writes).toHaveLength(1);
  });

  test("a failed write keeps the uses for the next flush", async () => {
    const { store, service, writes, advance, failNextWrite } = setup();
    const { record } = await store.create("GOWNER");
    service.touch(record.hash);
    failNextWrite();
    advance(KEY_ACTIVITY_FLUSH_INTERVAL_MS);
    await service.flushIfDue();
    advance(KEY_ACTIVITY_FLUSH_INTERVAL_MS);
    await service.flushIfDue();
    expect(writes).toHaveLength(2);
    expect((await store.findByHash(record.hash))!.lastUsedAt).not.toBeNull();
  });

  test("shutdown writes what is pending without waiting for the interval", async () => {
    const { store, service } = setup();
    const { record } = await store.create("GOWNER");
    service.touch(record.hash);
    await service.onApplicationShutdown();
    expect((await store.findByHash(record.hash))!.lastUsedAt).not.toBeNull();
  });
});
