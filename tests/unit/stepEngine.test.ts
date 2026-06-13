import { test, expect } from "bun:test";
import { FastPathUnavailableError, AssetRouteLostError } from "@/lib/utils/errors";

test("FastPathUnavailableError › carries the full degrade reason as its message", () => {
  const reason =
    "This close needs 121 operations, over the 100-operation limit for one transaction; falling back to step-by-step.";
  const e = new FastPathUnavailableError(reason);
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("FastPathUnavailableError");
  expect(e.message).toBe(reason);
});

test("AssetRouteLostError › is an Error whose message names the asset code", () => {
  const e = new AssetRouteLostError("RUGPULL");
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("AssetRouteLostError");
  expect(e.assetCode).toBe("RUGPULL");
  expect(e.message).toContain("RUGPULL");
});
