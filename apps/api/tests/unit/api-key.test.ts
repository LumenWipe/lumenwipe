import { test, expect } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { ApiKeyService } from "@/auth/api-key.service";
import {
  bearerFromRequest,
  clientIdentity,
  ipTracker,
  throttleStorageKey,
} from "@/auth/rate-limiter";

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

test("bearerFromRequest reads the bearer value, null when absent or empty", () => {
  expect(bearerFromRequest({ headers: { authorization: "Bearer key_abc" } })).toBe("key_abc");
  expect(bearerFromRequest({ headers: { authorization: "Bearer   " } })).toBeNull();
  expect(bearerFromRequest({ headers: { authorization: "Basic abc" } })).toBeNull();
  expect(bearerFromRequest({ headers: {} })).toBeNull();
  expect(bearerFromRequest({})).toBeNull();
});

test("ipTracker is namespaced apart from key trackers", () => {
  expect(ipTracker({ headers: {}, ip: "1.2.3.4" })).toBe("ip:1.2.3.4");
  expect(ipTracker({})).toBe("ip:unknown");
});

test("clientIdentity maps IPv4-mapped addresses to IPv4 and IPv6 addresses to their /64", () => {
  expect(clientIdentity("203.0.113.4")).toBe("203.0.113.4");
  expect(clientIdentity("::ffff:203.0.113.4")).toBe("203.0.113.4");
  expect(clientIdentity("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(clientIdentity("2001:DB8:1:2::7")).toBe("2001:db8:1:2::/64");
  expect(clientIdentity("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(clientIdentity("::1")).toBe("0:0:0:0::/64");
  expect(clientIdentity(undefined)).toBe("unknown");
});

test("throttleStorageKey buckets per (name, tracker), one bucket per key across routes", () => {
  // Takes no route input, so the same key maps to one bucket regardless of endpoint.
  expect(throttleStorageKey("default", "key_abc")).toBe(throttleStorageKey("default", "key_abc"));
  expect(throttleStorageKey("default", "key_abc")).not.toBe(
    throttleStorageKey("default", "key_xyz")
  );
  // hashed: the raw key never appears in the storage key
  expect(throttleStorageKey("default", "key_abc")).not.toContain("key_abc");
});
