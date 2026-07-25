import { test, expect } from "bun:test";
import { parseClaimPredicate } from "@/lib/stellar/horizon-adapter";

// Anchor used for rel_before deadline math: 2024-01-01T00:00:00Z.
const CREATED_AT = 1704067200;

test("parseClaimPredicate › unconditional (no keys) → unconditional", () => {
  expect(parseClaimPredicate({}, CREATED_AT)).toEqual({ type: "unconditional" });
  expect(parseClaimPredicate({ unconditional: true }, CREATED_AT)).toEqual({
    type: "unconditional",
  });
});

test("parseClaimPredicate › abs_before_epoch is used verbatim", () => {
  expect(parseClaimPredicate({ abs_before_epoch: "1735689600" }, CREATED_AT)).toEqual({
    type: "before_absolute_time",
    absBeforeEpoch: "1735689600",
  });
});

test("parseClaimPredicate › abs_before ISO string is converted to epoch seconds", () => {
  // 2025-01-01T00:00:00Z = 1735689600
  expect(parseClaimPredicate({ abs_before: "2025-01-01T00:00:00Z" }, CREATED_AT)).toEqual({
    type: "before_absolute_time",
    absBeforeEpoch: "1735689600",
  });
});

test("parseClaimPredicate › abs_before_epoch wins over abs_before when both present", () => {
  const raw = { abs_before_epoch: "111", abs_before: "2025-01-01T00:00:00Z" };
  expect(parseClaimPredicate(raw, CREATED_AT)).toEqual({
    type: "before_absolute_time",
    absBeforeEpoch: "111",
  });
});

test("parseClaimPredicate › rel_before computes deadline from the created-at anchor", () => {
  expect(parseClaimPredicate({ rel_before: "3600" }, CREATED_AT)).toEqual({
    type: "before_relative_time",
    relBeforeSeconds: "3600",
    deadlineEpoch: String(CREATED_AT + 3600),
  });
});

test("parseClaimPredicate › and/or/not recurse", () => {
  const raw = {
    and: [
      { not: { abs_before_epoch: "111" } },
      { or: [{ unconditional: true }, { rel_before: "60" }] },
    ],
  };
  expect(parseClaimPredicate(raw, CREATED_AT)).toEqual({
    type: "and",
    predicates: [
      { type: "not", predicate: { type: "before_absolute_time", absBeforeEpoch: "111" } },
      {
        type: "or",
        predicates: [
          { type: "unconditional" },
          {
            type: "before_relative_time",
            relBeforeSeconds: "60",
            deadlineEpoch: String(CREATED_AT + 60),
          },
        ],
      },
    ],
  });
});
