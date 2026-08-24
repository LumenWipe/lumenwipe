import { test, expect } from "bun:test";
import { hardBlockersOf, isResolvableHere } from "@/lib/plan/resolvable-blockers";

// Regression coverage for a real mainnet account that could not be closed from the UI.
//
// The API reports an unresolved claimable balance as a blocker AND offers the decision that
// resolves it - the plan stays auditable about what it chose not to do. A client that reads
// every blocker as "this close cannot proceed" therefore hides the controls that would unblock
// it. The analyze page did exactly that with a bare `blockers.length === 0`, so 23
// claimable-balance blockers emptied the list of 38 balance-bearing assets.

test("claimable-balance blockers are resolvable on the analyze page", () => {
  expect(isResolvableHere({ code: "claimable_balance_unclaimable" })).toBe(true);
  expect(isResolvableHere({ code: "claimable_balance_forfeited" })).toBe(true);
});

test("every other blocker still hard-blocks", () => {
  for (const code of ["account_too_large", "sponsored_entries", "auth_immutable", undefined]) {
    expect(isResolvableHere({ code })).toBe(false);
  }
});

test("a blocker with no code hard-blocks - absence of a code is not permission", () => {
  expect(hardBlockersOf([{ code: undefined, message: "x" }])).toHaveLength(1);
});

test("23 claimable-balance blockers do not hard-block, but one real blocker does", () => {
  // The shape of the account that surfaced this: many resolvable blockers, and the question is
  // whether the asset cards render at all.
  const claimables = Array.from({ length: 23 }, () => ({
    code: "claimable_balance_unclaimable",
    message: "…",
  }));
  expect(hardBlockersOf(claimables)).toHaveLength(0);
  expect(hardBlockersOf([...claimables, { code: "auth_immutable", message: "…" }])).toHaveLength(1);
});
