import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { AdminGuard } from "@/admin/admin.guard";

function contextWithAuth(header?: string): ExecutionContext {
  const req = { headers: header ? { authorization: header } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function statusOf(e: unknown): number {
  return e instanceof HttpException ? e.getStatus() : -1;
}

function codeOf(e: unknown): unknown {
  return e instanceof HttpException
    ? (e.getResponse() as { error: { code: string } }).error.code
    : null;
}

const ORIGINAL_TOKEN = process.env.ADMIN_API_TOKEN;
const ORIGINAL_PROJECT = process.env.FIRESTORE_PROJECT_ID;

beforeEach(() => {
  delete process.env.ADMIN_API_TOKEN;
  delete process.env.FIRESTORE_PROJECT_ID;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_PROJECT === undefined) delete process.env.FIRESTORE_PROJECT_ID;
  else process.env.FIRESTORE_PROJECT_ID = ORIGINAL_PROJECT;
});

test("503s when ADMIN_API_TOKEN is not configured, even with a correct-looking header", () => {
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  const guard = new AdminGuard();
  try {
    guard.canActivate(contextWithAuth("Bearer anything"));
    throw new Error("expected canActivate to throw");
  } catch (e) {
    expect(statusOf(e)).toBe(503);
    expect(codeOf(e)).toBe("admin_api_not_configured");
  }
});

test("503s when FIRESTORE_PROJECT_ID is not configured, even with the right token", () => {
  process.env.ADMIN_API_TOKEN = "secret-token";
  const guard = new AdminGuard();
  try {
    guard.canActivate(contextWithAuth("Bearer secret-token"));
    throw new Error("expected canActivate to throw");
  } catch (e) {
    expect(statusOf(e)).toBe(503);
    expect(codeOf(e)).toBe("admin_api_not_configured");
  }
});

test("401s on a missing or wrong token once configured", () => {
  process.env.ADMIN_API_TOKEN = "secret-token";
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  const guard = new AdminGuard();

  for (const header of [undefined, "Bearer wrong", "secret-token", "Bearer "]) {
    try {
      guard.canActivate(contextWithAuth(header));
      throw new Error("expected canActivate to throw");
    } catch (e) {
      expect(statusOf(e)).toBe(401);
      expect(codeOf(e)).toBe("unauthorized");
    }
  }
});

test("passes with the correct token once configured", () => {
  process.env.ADMIN_API_TOKEN = "secret-token";
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  const guard = new AdminGuard();
  expect(guard.canActivate(contextWithAuth("Bearer secret-token"))).toBe(true);
});

test("rejects a token of a different length without throwing on the length mismatch itself", () => {
  // timingSafeEqual throws on mismatched buffer lengths - the guard must catch that itself
  // rather than turning a short/long guess into an unhandled 500.
  process.env.ADMIN_API_TOKEN = "a-much-longer-secret-token";
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  const guard = new AdminGuard();
  try {
    guard.canActivate(contextWithAuth("Bearer short"));
    throw new Error("expected canActivate to throw");
  } catch (e) {
    expect(statusOf(e)).toBe(401);
  }
});
