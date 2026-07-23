import { test, expect } from "bun:test";
import {
  stroopsToXlm,
  xlmToStroops,
  estimateFeeLumens,
  calcRecoverableReserve,
} from "@/lib/utils/amounts";

test("stroopsToXlm › 10_000_000 stroops = 1 XLM", () => {
  expect(stroopsToXlm(10_000_000)).toBe("1");
});

test("stroopsToXlm › 1 stroop = 0.0000001 XLM", () => {
  expect(stroopsToXlm(1)).toBe("0.0000001");
});

test("stroopsToXlm › 0 stroops = 0 XLM", () => {
  expect(stroopsToXlm(0)).toBe("0");
});

test("stroopsToXlm › 15_000_000 stroops = 1.5 XLM", () => {
  expect(stroopsToXlm(15_000_000)).toBe("1.5");
});

test("stroopsToXlm › string input is accepted", () => {
  expect(stroopsToXlm("10000000")).toBe("1");
});

test("xlmToStroops › 1 XLM = 10_000_000 stroops", () => {
  expect(xlmToStroops("1")).toBe("10000000");
});

test("xlmToStroops › 1.5 XLM = 15_000_000 stroops", () => {
  expect(xlmToStroops("1.5")).toBe("15000000");
});

test("xlmToStroops › 0.0000001 XLM = 1 stroop", () => {
  expect(xlmToStroops("0.0000001")).toBe("1");
});

test("xlmToStroops › integer string without decimal", () => {
  expect(xlmToStroops("10")).toBe("100000000");
});

test("estimateFeeLumens › 1 op = 0.00001 XLM (100 stroops)", () => {
  expect(estimateFeeLumens(1)).toBe("0.00001");
});

test("estimateFeeLumens › 100 ops = 0.001 XLM", () => {
  expect(estimateFeeLumens(100)).toBe("0.001");
});

test("estimateFeeLumens › 0 ops = 0 XLM", () => {
  expect(estimateFeeLumens(0)).toBe("0");
});

test("calcRecoverableReserve › 4 subentries = 2 XLM", () => {
  expect(calcRecoverableReserve(4)).toBe("2.0000000");
});

test("calcRecoverableReserve › 0 subentries = 0 XLM", () => {
  expect(calcRecoverableReserve(0)).toBe("0.0000000");
});

test("calcRecoverableReserve › 1 subentry = 0.5 XLM", () => {
  expect(calcRecoverableReserve(1)).toBe("0.5000000");
});
