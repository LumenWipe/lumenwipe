/**
 * TEST-ONLY stand-in for the shared exit-adapter invariant harness (issue #153, epic #151),
 * which does not exist in production code as of this PR. Blend/FxDAO exit adapters (#152 the
 * wasmHash registry, #153 this harness, #154 the Blend adapter, and FxDAO's equivalent) are all
 * still unbuilt - confirmed by exhaustive grep across apps/api/src during #167's own research: no
 * exit/withdraw/repay transaction builder exists for any Soroban DeFi protocol, only read-only
 * position detection (apps/api/src/lib/defi-positions/).
 *
 * This implements exactly the invariant contract #153's own issue body defines - health-factor
 * check before withdraw, repay-before-withdraw ordering, a backstop queued-withdrawal (Q4W)
 * cooldown check - as a minimal reference so undercollateralized-vaults.test.ts and
 * queued-backstop-withdrawals.test.ts can validate the *logic* of those two named hostile states
 * now, per your instruction to write them against a stub with a note to redo them for real once
 * the adapter lands, rather than leaving those two scenarios entirely uncovered until #153/#154
 * merge.
 *
 * NOT exported from src/, NOT imported by any controller or production code path, and NOT a
 * preview of #153's real design - it is deliberately minimal, only as much as these two test
 * files need. When #154 (or its FxDAO equivalent) lands, delete this file and rewrite both test
 * files against the real adapter and the real #153 harness; do not extend this stub further.
 */
import type { PlanBlocker } from "@lumenwipe/types";

export interface StubVaultPosition {
  /** USD value of posted collateral, as a decimal string. */
  collateralValueUsd: string;
  /** USD value of outstanding debt, as a decimal string. Zero means no debt to repay. */
  debtValueUsd: string;
  /** Liquidation threshold in basis points of collateral/debt (e.g. 11000 = 110%) - below this,
   *  the position is undercollateralized and a withdraw would push it toward liquidation. */
  minHealthFactorBps: number;
}

/** health factor = collateralValueUsd / debtValueUsd, expressed in the same bps scale as
 *  minHealthFactorBps. A position with zero debt has no health factor to violate. */
function healthFactorBps(position: StubVaultPosition): number | null {
  const debt = parseFloat(position.debtValueUsd);
  if (debt <= 0) return null;
  const collateral = parseFloat(position.collateralValueUsd);
  return Math.round((collateral / debt) * 10000);
}

/** Blocks a withdraw that would leave (or already leaves) the position undercollateralized. */
export function assessVaultHealthInvariant(position: StubVaultPosition): PlanBlocker[] {
  const hf = healthFactorBps(position);
  if (hf === null) return [];
  if (hf < position.minHealthFactorBps) {
    return [
      {
        code: "vault_undercollateralized",
        message:
          `This vault's health factor (${(hf / 100).toFixed(2)}%) is below the ` +
          `${(position.minHealthFactorBps / 100).toFixed(2)}% liquidation threshold. ` +
          `Withdrawing collateral before repaying debt would push it toward liquidation.`,
      },
    ];
  }
  return [];
}

/** Repay-before-withdraw ordering: a position with outstanding debt must be repaid before its
 *  collateral is withdrawn, never the reverse - matching #153's own stated invariant. */
export function assessRepayBeforeWithdrawOrder(
  position: StubVaultPosition,
  order: Array<"repay" | "withdraw">
): PlanBlocker[] {
  const hasDebt = parseFloat(position.debtValueUsd) > 0;
  if (!hasDebt) return [];
  const withdrawIdx = order.indexOf("withdraw");
  const repayIdx = order.indexOf("repay");
  if (withdrawIdx !== -1 && (repayIdx === -1 || repayIdx > withdrawIdx)) {
    return [
      {
        code: "withdraw_before_repay",
        message:
          "This vault has outstanding debt. Collateral cannot be withdrawn before the debt " +
          "is repaid.",
      },
    ];
  }
  return [];
}

export interface StubBackstopShare {
  /** ISO timestamp the withdrawal was queued at, or null if never queued. Blend's backstop
   *  requires queuing a withdrawal (Q4W) before it can be executed - it cannot be withdrawn
   *  immediately, even with a healthy position. */
  queuedForWithdrawalAt: string | null;
  /** The protocol's required cooldown between queuing and executing a withdrawal. */
  cooldownSeconds: number;
}

/** Blocks an immediate-exit assumption for a backstop share that either was never queued for
 *  withdrawal, or was queued but its cooldown has not yet elapsed. */
export function assessBackstopQueueInvariant(share: StubBackstopShare, now: Date): PlanBlocker[] {
  if (share.queuedForWithdrawalAt === null) {
    return [
      {
        code: "backstop_withdrawal_not_queued",
        message:
          "This backstop share has not been queued for withdrawal. Blend's backstop requires " +
          "queuing (Q4W) before a withdrawal can execute - it cannot be withdrawn immediately.",
      },
    ];
  }
  const queuedAtMs = Date.parse(share.queuedForWithdrawalAt);
  const elapsedSeconds = (now.getTime() - queuedAtMs) / 1000;
  if (elapsedSeconds < share.cooldownSeconds) {
    const remaining = Math.ceil(share.cooldownSeconds - elapsedSeconds);
    return [
      {
        code: "backstop_withdrawal_cooling_down",
        message:
          `This backstop share's withdrawal was queued but is still cooling down - ` +
          `${remaining} second(s) remain before it can execute.`,
      },
    ];
  }
  return [];
}
