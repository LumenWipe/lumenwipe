import { test, expect } from "bun:test";
import {
  hardBlockersOf,
  isResolvableHere,
  proceedError,
  displayBlockersOf,
} from "@/lib/plan/resolvable-blockers";

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

// ─── The proceed gate ────────────────────────────────────────────────────────
//
// Regression: "Begin execution" refused any plan carrying a blocker, including
// claimable_balance_forfeited - the informational record of a choice the user just made. The
// close was unreachable the moment anyone forfeited a balance, with the card's own warning
// re-rendered as the error.

test("proceedError › an acknowledged forfeit alone does not stop the flow", () => {
  expect(
    proceedError([
      { code: "claimable_balance_forfeited", message: "You chose to forfeit 9.0000000 JUNK…" },
    ])
  ).toBeNull();
});

test("proceedError › a hard blocker still stops it, and only its message surfaces", () => {
  const err = proceedError([
    { code: "claimable_balance_forfeited", message: "You chose to forfeit 9.0000000 JUNK…" },
    { message: "The destination account does not exist." },
  ]);
  expect(err).toBe("The destination account does not exist.");
});

test("proceedError › no blockers, no error", () => {
  expect(proceedError([])).toBeNull();
});

// ─── the unconfirmed-but-no-trustlines DeFi code: non-blocking, but still shown ─────
//
// Unlike claimable_balance_forfeited (which has its own card and would be confusing to repeat
// here), this code has no dedicated UI elsewhere - it must still appear in the generic panel,
// or a real signal ("we couldn't fully confirm this") would vanish with nothing else showing it.

test("a confirmed-empty DeFi blocker does not stop the flow", () => {
  expect(
    proceedError([
      {
        code: "defi_positions_unconfirmed_no_trustlines",
        message: "DeFi position data could not be confirmed…",
      },
    ])
  ).toBeNull();
});

test("displayBlockersOf keeps the DeFi blocker visible even though it is non-blocking", () => {
  const blockers = [
    { code: "defi_positions_unconfirmed_no_trustlines", message: "…" },
    { code: "claimable_balance_forfeited", message: "…" },
  ];
  expect(displayBlockersOf(blockers)).toEqual([blockers[0]]);
});

// ─── the unconfirmed-but-detected DeFi code: a real position, still non-blocking ────
//
// Regression: a real mainnet account with a genuine, fully-recognized Blend position still
// showed "Cannot proceed" and disabled "Begin execution," even though the plan already included
// a working exit step for that exact position. Finding something concrete via a code-hash-
// verified on-chain read is a stronger signal than finding nothing, so it must not block harder
// than the confirmed-empty case above.

test("a detected-position DeFi blocker does not stop the flow either", () => {
  expect(
    proceedError([
      {
        code: "defi_positions_unconfirmed_but_detected",
        message: "DeFi position data could not be confirmed by the indexer, but…",
      },
    ])
  ).toBeNull();
});

test("displayBlockersOf keeps the detected-position DeFi blocker visible too", () => {
  const blockers = [{ code: "defi_positions_unconfirmed_but_detected", message: "…" }];
  expect(displayBlockersOf(blockers)).toEqual(blockers);
});

// ─── the user-verified DeFi code: only ever produced after an explicit acknowledgement ─────
//
// Real mainnet regression: a basic asset-issuer account with one classic trustline unrelated to
// any DeFi protocol hard-blocked with `defi_positions_unavailable` (the zero-trustline leniency
// above only covers an account with none at all). A human who checked manually can acknowledge
// it; the API then re-plans with this code instead, and it must read as resolved everywhere
// `defi_positions_unconfirmed_no_trustlines` already does.

test("the user-verified DeFi code does not stop the flow", () => {
  expect(
    proceedError([
      {
        code: "defi_positions_unconfirmed_user_verified",
        message: "DeFi position data could not be confirmed, but you confirmed manually…",
      },
    ])
  ).toBeNull();
});

test("displayBlockersOf keeps the user-verified DeFi blocker visible too", () => {
  const blockers = [{ code: "defi_positions_unconfirmed_user_verified", message: "…" }];
  expect(displayBlockersOf(blockers)).toEqual(blockers);
});

// ─── the raw, unacknowledged hard blocker: still trapping by default ───────────────────
//
// DEFI_POSITIONS_UNAVAILABLE_CODE deliberately is NOT in resolvable-blockers.ts's own
// unconditional sets (see its doc comment) - PlanView applies a local, acknowledgement-
// conditional exception instead. Unmodified, hardBlockersOf/proceedError must keep treating it
// as a genuine hard blocker, since that is exactly what `handleProceed`'s post-decision check
// relies on to catch an acknowledgement that never actually made it into the request.

test("defi_positions_unavailable still hard-blocks on its own, unlike its acknowledged sibling", () => {
  const err = proceedError([
    { code: "defi_positions_unavailable", message: "DeFi position data could not be confirmed…" },
  ]);
  expect(err).not.toBeNull();
});
