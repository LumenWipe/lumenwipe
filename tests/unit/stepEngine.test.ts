import { test, expect } from "bun:test";
import { FastPathUnavailableError } from "@/lib/utils/errors";

test("FastPathUnavailableError › carries the offending asset code", () => {
  const e = new FastPathUnavailableError("USDC");
  expect(e).toBeInstanceOf(Error);
  expect(e.message).toContain("USDC");
});
