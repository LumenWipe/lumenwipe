/**
 * Adversarial coverage: undercollateralized vaults (docs/architecture.md §17, issue #167).
 *
 * STUB HARNESS - see ./fixtures/exit-adapter-invariant-stub.ts for the full rationale. Blend and
 * FxDAO exit adapters (epic #151: #152, #153, #154, and FxDAO's equivalent) do not exist in
 * production code yet, so this file validates the invariant *logic* against a minimal
 * reference implementation of #153's own stated contract, not this tool's actual behavior. It
 * must be rewritten against the real exit adapter and the real #153 harness once #154 (or the
 * FxDAO equivalent) lands - do not treat these tests as coverage of shipped behavior.
 */
import { test, expect } from "bun:test";
import {
  assessVaultHealthInvariant,
  assessRepayBeforeWithdrawOrder,
  type StubVaultPosition,
} from "./fixtures/exit-adapter-invariant-stub";

function position(over: Partial<StubVaultPosition> = {}): StubVaultPosition {
  return {
    collateralValueUsd: "150",
    debtValueUsd: "100",
    minHealthFactorBps: 11000, // 110% liquidation threshold
    ...over,
  };
}

test("a healthy position (150% collateralized) is not blocked", () => {
  expect(assessVaultHealthInvariant(position())).toEqual([]);
});

test("a position exactly at the liquidation threshold is not blocked", () => {
  // 110/100 = 110% exactly matches minHealthFactorBps - the boundary itself is safe.
  expect(assessVaultHealthInvariant(position({ collateralValueUsd: "110" }))).toEqual([]);
});

test("an undercollateralized position (105% against a 110% threshold) is blocked before withdraw", () => {
  const blockers = assessVaultHealthInvariant(position({ collateralValueUsd: "105" }));
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.code).toBe("vault_undercollateralized");
});

test("a position with zero debt has no health factor to violate", () => {
  expect(assessVaultHealthInvariant(position({ debtValueUsd: "0" }))).toEqual([]);
});

test("withdrawing before repaying is blocked when the vault carries debt", () => {
  const blockers = assessRepayBeforeWithdrawOrder(position(), ["withdraw", "repay"]);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.code).toBe("withdraw_before_repay");
});

test("repaying before withdrawing is not blocked", () => {
  expect(assessRepayBeforeWithdrawOrder(position(), ["repay", "withdraw"])).toEqual([]);
});

test("withdrawing with no debt at all is not blocked regardless of order", () => {
  expect(assessRepayBeforeWithdrawOrder(position({ debtValueUsd: "0" }), ["withdraw"])).toEqual([]);
});
