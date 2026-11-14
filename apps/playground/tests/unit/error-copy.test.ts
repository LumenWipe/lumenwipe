import { test, expect } from "bun:test";
import {
  blockerCopy,
  CREDENTIALS_UNAVAILABLE_COPY,
  credentialsErrorCopy,
  errorCopy,
  GENERIC_BLOCKER_COPY,
  GENERIC_ERROR_COPY,
} from "@/lib/error-copy";

const CODES = [
  "session_not_found",
  "provision_failed",
  "playground_refilling",
  "faucet_rate_limited",
  "faucet_unavailable",
  "playground_busy",
  "rate_limited",
  "tx_failed",
  "testnet_liquidity_unavailable",
  "testnet_lending_unavailable",
  "demolish_failed",
  "demolish_outcome_unknown",
  "demolish_fee_unsponsored",
  "demolish_delivery_unconfirmed",
  "demolish_decision_unanswerable",
  "demolish_blocked",
  "demolish_in_progress",
  "resolution_unavailable",
  "resolution_not_recorded",
  "resolve_failed",
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
  "session_expired",
  "extension_used",
  "extension_not_yet",
];

test("every route error code maps to its own copy", () => {
  const copies = CODES.map((code) => errorCopy(code));
  expect(new Set(copies).size).toBe(CODES.length);
  for (const copy of copies) expect(copy).not.toBe(GENERIC_ERROR_COPY);
});

test("a faucet rate limit and a faucet outage read differently, both in plain language", () => {
  const limited = errorCopy("faucet_rate_limited");
  const down = errorCopy("faucet_unavailable");
  expect(limited).not.toBe(down);
  expect(limited).toContain("limiting requests");
  expect(down).toContain("is down");
  for (const copy of [limited, down]) {
    expect(copy).toContain("temporarily unavailable");
    expect(copy).not.toMatch(/\b(429|50\d|HTTP|Friendbot)\b/);
  }
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

test("each blocker the playground plans a fix for has its own copy; any other gets the generic line", () => {
  const copies = ["sponsorship_claimable_balance_unrevocable", "sponsorship_unaffordable"].map(
    blockerCopy
  );
  expect(new Set(copies).size).toBe(2);
  for (const copy of copies) expect(copy).not.toBe(GENERIC_BLOCKER_COPY);
  expect(blockerCopy("subentries_unenumerated")).toBe(GENERIC_BLOCKER_COPY);
  expect(blockerCopy("toString")).toBe(GENERIC_BLOCKER_COPY);
});

test("a failed key request says why: limited, time up, gone, or unavailable", () => {
  const limited = credentialsErrorCopy("rate_limited");
  const timeUp = credentialsErrorCopy("session_expired");
  const gone = credentialsErrorCopy("session_not_found");
  expect(new Set([limited, timeUp, gone, CREDENTIALS_UNAVAILABLE_COPY]).size).toBe(4);
  expect(timeUp).toContain("still close the account here");
  for (const code of ["not_configured", "network_error", "toString", null]) {
    expect(credentialsErrorCopy(code)).toBe(CREDENTIALS_UNAVAILABLE_COPY);
  }
  for (const copy of [limited, timeUp, gone, CREDENTIALS_UNAVAILABLE_COPY]) {
    expect(copy).not.toMatch(/_|\b(410|429|503)\b/);
  }
});
