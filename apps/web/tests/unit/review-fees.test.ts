import { expect, test } from "bun:test";
import { stepFeeStroops, totalFeeStroops, transactionCountLine } from "@/lib/plan/review-fees";

const fee = (estimatedFeeLumens: string) => ({ estimatedFeeLumens });

test("the fee total is the exact sum in stroops, where a float sum loses the last stroops", () => {
  const steps = [fee("10000000000.0000001"), fee("0.0000001"), fee("0.0000001")];
  const floatSum = steps.reduce((s, x) => s + parseFloat(x.estimatedFeeLumens), 0).toFixed(7);
  expect(floatSum).toBe("10000000000.0000000");
  expect(totalFeeStroops(steps)).toBe("100000000000000003");
});

test("each step's fee is whole stroops", () => {
  expect(stepFeeStroops(fee("0.0000100"))).toBe(BigInt(100));
  expect(stepFeeStroops(fee("0.01"))).toBe(BigInt(100000));
  expect(totalFeeStroops([fee("0.0000100"), fee("0.0100000")])).toBe("100100");
  expect(totalFeeStroops([])).toBe("0");
});

test("a fee that is not an amount of XLM is unknown, and so is any total holding one", () => {
  for (const bad of ["", "abc", "-1", "1e5", "0.00000001", "1,5"]) {
    expect(stepFeeStroops(fee(bad))).toBeNull();
    expect(totalFeeStroops([fee("0.0000100"), fee(bad)])).toBeNull();
  }
});

test("the count is about N, and at least 1 when the plan cannot know it", () => {
  expect(transactionCountLine(3)).toBe(
    "About 3 transactions to sign (this can change if your account changes)."
  );
  expect(transactionCountLine(1)).toBe(
    "About 1 transaction to sign (this can change if your account changes)."
  );
  expect(transactionCountLine(null)).toMatch(/^At least 1 transaction to sign\./);
});
