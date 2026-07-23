import { test, expect } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { ApiKeyService } from "@/auth/api-key.service";
import { throttleStorageKey, trackerForRequest } from "@/auth/api-key-throttler.guard";
import { MeteringService } from "@/metering/metering.service";

function service(apiKeys: string): ApiKeyService {
  return new ApiKeyService({ get: () => apiKeys } as unknown as ConfigService);
}

test("ApiKeyService resolves known keys to their integrator label", () => {
  const s = service("lumenwipe-web=key_abc, polar=key_xyz");
  expect(s.resolve("key_abc")).toBe("lumenwipe-web");
  expect(s.resolve("key_xyz")).toBe("polar");
});

test("ApiKeyService rejects unknown or empty keys", () => {
  const s = service("web=key_abc");
  expect(s.resolve("nope")).toBeNull();
  expect(s.resolve("")).toBeNull();
});

test("ApiKeyService skips malformed pairs", () => {
  const s = service(",=,web=key_abc,bogus,=orphan,label=");
  expect(s.resolve("key_abc")).toBe("web");
  expect(s.resolve("orphan")).toBeNull();
});

test("trackerForRequest prefers the bearer key, falls back to ip", () => {
  expect(trackerForRequest({ headers: { authorization: "Bearer key_abc" } })).toBe("key_abc");
  expect(trackerForRequest({ headers: {}, ip: "1.2.3.4" })).toBe("1.2.3.4");
  expect(trackerForRequest({})).toBe("unknown");
});

test("throttleStorageKey buckets per (name, tracker), one bucket per key across routes", () => {
  // Takes no route input, so the same key maps to one bucket regardless of endpoint.
  expect(throttleStorageKey("default", "key_abc")).toBe(throttleStorageKey("default", "key_abc"));
  expect(throttleStorageKey("default", "key_abc")).not.toBe(throttleStorageKey("default", "key_xyz"));
  // hashed: the raw key never appears in the storage key
  expect(throttleStorageKey("default", "key_abc")).not.toContain("key_abc");
});

test("MeteringService counts requests per label", () => {
  const m = new MeteringService();
  m.record("polar");
  m.record("polar");
  m.record("web");
  expect(m.snapshot()).toEqual({ polar: 2, web: 1 });
});
