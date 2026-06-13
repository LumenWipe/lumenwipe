import { test, expect } from "bun:test";
import { FastPathUnavailableError } from "@/lib/utils/errors";

test("FastPathUnavailableError › carries the full degrade reason as its message", () => {
  const reason =
    "This close needs 121 operations, over the 100-operation limit for one transaction; falling back to step-by-step.";
  const e = new FastPathUnavailableError(reason);
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("FastPathUnavailableError");
  expect(e.message).toBe(reason);
});
