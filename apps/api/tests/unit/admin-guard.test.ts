import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as crypto from "crypto";
import { randomBytes } from "crypto";
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

function newToken(): string {
  return randomBytes(16).toString("hex");
}

function rejection(header?: string): { status: number; code: unknown } {
  try {
    new AdminGuard().canActivate(contextWithAuth(header));
  } catch (e) {
    return { status: statusOf(e), code: codeOf(e) };
  }
  throw new Error("expected canActivate to throw");
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
  expect(rejection(`Bearer ${newToken()}`)).toEqual({
    status: 503,
    code: "admin_api_not_configured",
  });
});

test("503s when ADMIN_API_TOKEN is empty or only whitespace", () => {
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  for (const configured of ["", "   ", "\n", " \t\r\n"]) {
    process.env.ADMIN_API_TOKEN = configured;
    expect(rejection(`Bearer ${newToken()}`)).toEqual({
      status: 503,
      code: "admin_api_not_configured",
    });
  }
});

test("503s when FIRESTORE_PROJECT_ID is not configured, even with the right token", () => {
  const token = newToken();
  process.env.ADMIN_API_TOKEN = token;
  expect(rejection(`Bearer ${token}`)).toEqual({ status: 503, code: "admin_api_not_configured" });
});

test("401s on a missing or wrong token once configured", () => {
  const token = newToken();
  process.env.ADMIN_API_TOKEN = token;
  process.env.FIRESTORE_PROJECT_ID = "test-project";

  for (const header of [undefined, `Bearer ${newToken()}`, token, "Bearer "]) {
    expect(rejection(header)).toEqual({ status: 401, code: "unauthorized" });
  }
});

test("passes with the correct token once configured", () => {
  const token = newToken();
  process.env.ADMIN_API_TOKEN = token;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  expect(new AdminGuard().canActivate(contextWithAuth(`Bearer ${token}`))).toBe(true);
});

test("passes when the configured token carries surrounding whitespace", () => {
  const token = newToken();
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  for (const configured of [`${token}\n`, `${token}\r\n`, ` \t${token}\n`]) {
    process.env.ADMIN_API_TOKEN = configured;
    expect(new AdminGuard().canActivate(contextWithAuth(`Bearer ${token}`))).toBe(true);
  }
});

test("401s on a token that differs from a whitespace-padded configured one in one character", () => {
  const token = newToken();
  const last = token.at(-1) === "0" ? "1" : "0";
  process.env.ADMIN_API_TOKEN = `${token}\n`;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  expect(rejection(`Bearer ${token.slice(0, -1)}${last}`)).toEqual({
    status: 401,
    code: "unauthorized",
  });
});

test("401s without throwing on a sent token shorter or longer than the configured one", () => {
  const token = newToken();
  process.env.ADMIN_API_TOKEN = token;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  for (const sent of [token.slice(0, 8), `${token}${newToken()}`, token.slice(0, -1)]) {
    expect(rejection(`Bearer ${sent}`)).toEqual({ status: 401, code: "unauthorized" });
  }
});

test("compares equal-length digests when the lengths differ, so no length check short-circuits", () => {
  const token = newToken();
  process.env.ADMIN_API_TOKEN = token;
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  const compare = spyOn(crypto, "timingSafeEqual");
  try {
    expect(rejection(`Bearer ${token}${newToken()}`)).toEqual({
      status: 401,
      code: "unauthorized",
    });
    expect(compare).toHaveBeenCalledTimes(1);
    const [a, b] = compare.mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  } finally {
    compare.mockRestore();
  }
});
