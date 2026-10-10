import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ERROR_CODES, isErrorCode } from "@/common/error-codes";
import { ERROR_CODE_DESCRIPTIONS } from "@/common/error-code-descriptions";
import { ErrorEnvelopeFilter } from "@/common/error-envelope.filter";
import { fail } from "@/common/fail";
import { API_VERSION } from "@/openapi";
import {
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

const SRC = resolve(import.meta.dir, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("error code registry", () => {
  test("has no duplicates and a description for every code", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(Object.keys(ERROR_CODE_DESCRIPTIONS).sort()).toEqual([...ERROR_CODES].sort());
  });

  test("every fail() call site names a registered code", () => {
    const unregistered: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("@/common/fail")) continue;
      for (const match of text.matchAll(/\bfail\(\s*"([a-z_]+)"/g)) {
        if (!isErrorCode(match[1])) unregistered.push(`${file}: ${match[1]}`);
      }
    }
    expect(unregistered).toEqual([]);
  });

  test("every code a DeFi exit adapter or the positions gate can raise is registered", () => {
    const files = [
      ...sourceFiles(join(SRC, "lib/defi-exits")),
      join(SRC, "lib/defi-positions/positions-gate.ts"),
    ];
    const unregistered: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /(?:\bcode: |_CODE =\s*)"([a-z_]+)"/g
      )) {
        const code = match[1]!;
        if (
          code !== "exit_position_gone" &&
          !code.startsWith("defi_positions_unconfirmed_") &&
          !isErrorCode(code)
        ) {
          unregistered.push(`${file}: ${code}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  test("fail() refuses an unregistered code at compile time and still throws the envelope", () => {
    try {
      // @ts-expect-error not a registered code
      fail("not_a_registered_code", "x", 400);
    } catch (e) {
      expect((e as HttpException).getResponse()).toEqual({
        error: { code: "not_a_registered_code", message: "x" },
      });
    }
  });
});

describe("ErrorEnvelopeFilter statuses without their own code", () => {
  function run(exception: unknown): { status: number; body: unknown } {
    const captured = { status: 0, body: undefined as unknown };
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => res }) };
    new ErrorEnvelopeFilter().catch(exception, host as never);
    return captured;
  }

  test("422 maps to the registered unprocessable_entity", () => {
    const { status, body } = run(new UnprocessableEntityException("nope"));
    expect(status).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe("unprocessable_entity");
    expect(isErrorCode("unprocessable_entity")).toBe(true);
  });

  test("503 maps to the registered service_unavailable", () => {
    const { status, body } = run(new ServiceUnavailableException("down"));
    expect(status).toBe(503);
    expect((body as { error: { code: string } }).error.code).toBe("service_unavailable");
    expect(isErrorCode("service_unavailable")).toBe(true);
  });
});

test("API_VERSION is the apps/api package version", () => {
  const manifest = JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8")) as {
    version: string;
  };
  expect(API_VERSION).toBe(manifest.version);
});
