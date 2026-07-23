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

test("AssetRouteLostError › carries the full asset id and display code", () => {
  const e = new AssetRouteLostError(
    "RUGPULL:GA7QYNF7SOWQ3GLR2BGMZEHHKMGAFR7RPBYYUSEZ5MFUYBNHRRDQNV4Z",
    "RUGPULL"
  );
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("AssetRouteLostError");
  expect(e.asset).toBe("RUGPULL:GA7QYNF7SOWQ3GLR2BGMZEHHKMGAFR7RPBYYUSEZ5MFUYBNHRRDQNV4Z");
  expect(e.assetCode).toBe("RUGPULL");
  expect(e.message).toContain("RUGPULL");
});
