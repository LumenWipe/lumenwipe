import { test, expect } from "bun:test";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";

const CODES = [
  "session_not_found",
  "friendbot_failed",
  "rate_limited",
  "tx_failed",
  "demolish_failed",
  "demolish_outcome_unknown",
  "demolish_decision_unanswerable",
  "demolish_started",
  "state_read_failed",
  "not_configured",
  "step_in_progress",
  "step_already_executed",
  "invalid_step",
  "step_not_in_plan",
  "step_out_of_order",
  "invalid_selection",
  "invalid_json",
  "cleanup_failed",
  "network_error",
];

test("every route error code maps to its own copy", () => {
  const copies = CODES.map((code) => errorCopy(code));
  expect(new Set(copies).size).toBe(CODES.length);
  for (const copy of copies) expect(copy).not.toBe(GENERIC_ERROR_COPY);
});

test("an unknown or missing code falls back to the generic plain-language line", () => {
  expect(errorCopy("op_underfunded")).toBe(GENERIC_ERROR_COPY);
  expect(errorCopy(undefined)).toBe(GENERIC_ERROR_COPY);
  expect(errorCopy("toString")).toBe(GENERIC_ERROR_COPY);
});

test("a 503 without a known code says the demo is temporarily unavailable", () => {
  expect(errorCopy(undefined, 503)).toBe(errorCopy("not_configured"));
  expect(errorCopy(undefined, 503)).toMatch(/temporarily unavailable/);
});
