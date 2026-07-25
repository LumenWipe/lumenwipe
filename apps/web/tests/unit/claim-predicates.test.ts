import { test, expect } from "bun:test";
import { isClaimableNow } from "@/lib/stellar/claim-predicates";
import type { ClaimPredicate } from "@/types/account";

const CLAIMANT = "GCLAIMANT00000000000000000000000000000000000000000000000000";
const NOW = new Date("2024-01-15T00:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

test("isClaimableNow › unconditional is always claimable", () => {
  const predicate: ClaimPredicate = { type: "unconditional" };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});

test("isClaimableNow › before_absolute_time in the future is claimable", () => {
  const predicate: ClaimPredicate = {
    type: "before_absolute_time",
    absBeforeEpoch: String(NOW_EPOCH + 3600),
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});

test("isClaimableNow › before_absolute_time in the past is not claimable", () => {
  const predicate: ClaimPredicate = {
    type: "before_absolute_time",
    absBeforeEpoch: String(NOW_EPOCH - 3600),
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(false);
});

test("isClaimableNow › before_relative_time with a future deadline is claimable", () => {
  const predicate: ClaimPredicate = {
    type: "before_relative_time",
    relBeforeSeconds: "3600",
    deadlineEpoch: String(NOW_EPOCH + 1800),
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});

test("isClaimableNow › before_relative_time with a past deadline is not claimable", () => {
  const predicate: ClaimPredicate = {
    type: "before_relative_time",
    relBeforeSeconds: "3600",
    deadlineEpoch: String(NOW_EPOCH - 1800),
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(false);
});

test("isClaimableNow › and requires every sub-predicate to hold", () => {
  const bothHold: ClaimPredicate = {
    type: "and",
    predicates: [
      { type: "unconditional" },
      { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH + 3600) },
    ],
  };
  const oneFails: ClaimPredicate = {
    type: "and",
    predicates: [
      { type: "unconditional" },
      { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH - 3600) },
    ],
  };
  expect(isClaimableNow(bothHold, CLAIMANT, NOW)).toBe(true);
  expect(isClaimableNow(oneFails, CLAIMANT, NOW)).toBe(false);
});

test("isClaimableNow › or requires at least one sub-predicate to hold", () => {
  const predicate: ClaimPredicate = {
    type: "or",
    predicates: [
      { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH - 3600) },
      { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH + 3600) },
    ],
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});

test("isClaimableNow › not inverts the wrapped predicate", () => {
  const predicate: ClaimPredicate = {
    type: "not",
    predicate: { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH - 3600) },
  };
  // The wrapped predicate ("claimable before a moment already in the past") is false;
  // negating a false predicate is true, so the claim is allowed now.
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});

test("isClaimableNow › nested and/or/not combination", () => {
  const predicate: ClaimPredicate = {
    type: "and",
    predicates: [
      {
        type: "not",
        predicate: { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH - 3600) },
      },
      {
        type: "or",
        predicates: [
          {
            type: "before_relative_time",
            relBeforeSeconds: "60",
            deadlineEpoch: String(NOW_EPOCH + 60),
          },
          { type: "before_absolute_time", absBeforeEpoch: String(NOW_EPOCH - 100) },
        ],
      },
    ],
  };
  expect(isClaimableNow(predicate, CLAIMANT, NOW)).toBe(true);
});
