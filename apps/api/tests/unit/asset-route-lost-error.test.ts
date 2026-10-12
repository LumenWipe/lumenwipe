import { test, expect } from "bun:test";
import { AssetRouteLostError } from "@/lib/utils/errors";

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
