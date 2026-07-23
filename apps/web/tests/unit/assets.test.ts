import { test, expect } from "bun:test";
import { parseAsset, formatAsset, isNativeAsset } from "@/lib/utils/assets";

test("parseAsset › 'native' returns XLM with null issuer", () => {
  expect(parseAsset("native")).toEqual({ code: "XLM", issuer: null });
});

test("parseAsset › 'XLM' returns XLM with null issuer", () => {
  expect(parseAsset("XLM")).toEqual({ code: "XLM", issuer: null });
});

test("parseAsset › CODE:ISSUER splits correctly", () => {
  const result = parseAsset("USDC:GABC123ISSUERKEY");
  expect(result.code).toBe("USDC");
  expect(result.issuer).toBe("GABC123ISSUERKEY");
});

test("parseAsset › 4-char code is preserved", () => {
  const result = parseAsset("USDT:GISSUER");
  expect(result.code).toBe("USDT");
});

test("parseAsset › code without issuer returns null issuer", () => {
  const result = parseAsset("USDC");
  expect(result.code).toBe("USDC");
  expect(result.issuer).toBeNull();
});

test("isNativeAsset › 'native' is native", () => {
  expect(isNativeAsset("native")).toBe(true);
});

test("isNativeAsset › 'XLM' is native", () => {
  expect(isNativeAsset("XLM")).toBe(true);
});

test("isNativeAsset › token asset is not native", () => {
  expect(isNativeAsset("USDC:GISSUER")).toBe(false);
});

test("isNativeAsset › empty string is not native", () => {
  expect(isNativeAsset("")).toBe(false);
});

test("formatAsset › native returns 'XLM'", () => {
  expect(formatAsset("native")).toBe("XLM");
});

test("formatAsset › token returns code portion only", () => {
  expect(formatAsset("USDC:GABC123ISSUERKEY")).toBe("USDC");
});

test("formatAsset › XLM shorthand returns 'XLM'", () => {
  expect(formatAsset("XLM")).toBe("XLM");
});
