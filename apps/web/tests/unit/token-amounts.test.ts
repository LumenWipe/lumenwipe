import { test, expect } from "bun:test";
import { formatTokenAmount } from "@/lib/utils/token-amounts";

test("formatTokenAmount › shifts the decimal point by the token's own decimals", () => {
  expect(formatTokenAmount("5000000", 7)).toBe("0.5");
  expect(formatTokenAmount("2500000000", 7)).toBe("250");
  expect(formatTokenAmount("100", 0)).toBe("100");
});

test("formatTokenAmount › a token with no known decimals is shown in raw units, as a self-contained phrase", () => {
  // No trailing "of" left dangling for a caller that doesn't append a token name right after -
  // this string must read correctly standing alone, e.g. "5000000 base units approved".
  expect(formatTokenAmount("5000000", null)).toBe("5000000 base units");
});

test("formatTokenAmount › an absurd decimals figure is treated the same as unknown, not trusted", () => {
  expect(formatTokenAmount("5000000", 39)).toBe("5000000 base units");
  expect(formatTokenAmount("5000000", -1)).toBe("5000000 base units");
});

test("formatTokenAmount › a non-numeric balance is passed through unchanged", () => {
  expect(formatTokenAmount("not-a-number", 7)).toBe("not-a-number");
});
