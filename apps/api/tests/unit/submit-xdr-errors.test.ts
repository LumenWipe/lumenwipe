import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { CloseController } from "@/close/close.controller";
import * as submitModule from "@/lib/stellar/submit";
import { InvalidXdrError } from "@/lib/utils/errors";
import type { StatsService } from "@/stats/stats.service";

const controller = new CloseController({} as unknown as StatsService);

afterEach(() => {
  spyOn(submitModule, "submitAndWait").mockRestore();
});

async function rejection(promise: Promise<unknown>): Promise<{ status: number; error: unknown }> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        error: (e.getResponse() as { error: unknown }).error,
      };
    }
    throw e;
  }
  throw new Error("expected submit to reject");
}

test("an undecodable envelope is a 400 invalid_signed_xdr", async () => {
  expect(await rejection(controller.submit("testnet", { signedXdr: "not-an-envelope" }))).toEqual({
    status: 400,
    error: {
      code: "invalid_signed_xdr",
      message: "The transaction envelope could not be decoded.",
    },
  });
});

test("submitAndWait raises the typed error for an undecodable envelope", async () => {
  await expect(submitModule.submitAndWait("not-an-envelope", "testnet")).rejects.toBeInstanceOf(
    InvalidXdrError
  );
});

test("a failure that merely mentions decoding is no longer read as a bad envelope", async () => {
  spyOn(submitModule, "submitAndWait").mockRejectedValue(
    new Error("could not decode the XDR in the RPC response")
  );
  expect(await rejection(controller.submit("testnet", { signedXdr: "AAAA" }))).toEqual({
    status: 502,
    error: { code: "submit_failed", message: "Failed to submit the transaction." },
  });
});

test("no controller classifies an error by testing its message", () => {
  const root = join(import.meta.dir, "../../src");
  const offenders: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (!file.endsWith(".controller.ts")) continue;
      const source = readFileSync(join(root, dir.name, file), "utf8");
      if (/\.test\(\s*\w+\.message/.test(source) || /isValidNetwork/.test(source)) {
        offenders.push(`${dir.name}/${file}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
