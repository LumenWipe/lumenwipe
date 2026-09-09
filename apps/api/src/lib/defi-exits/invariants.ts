import type { PlanBlocker } from "@lumenwipe/types";
import { WITHDRAWAL_KINDS, type ExitStepKind } from "./adapter";

/**
 * The shared invariant checks adapters call from `plan` and the runner applies from outside
 * (architecture.md §9.9). Pure functions over strings and numbers; every amount is a base-unit
 * integer string and every comparison is exact BigInt arithmetic, because an exit that
 * over-withdraws by one unit fails on-chain and one that rounds a floor up loses the user money.
 */

const BASE_UNITS = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;
/** Wide enough that any value a contract or price feed produces survives unrounded. */
const DECIMAL_SCALE = 18;

/** True for a decimal integer string - the only form an amount may take. */
export function isBaseUnits(value: unknown): value is string {
  return typeof value === "string" && BASE_UNITS.test(value);
}

function parseBaseUnits(value: string, label: string): bigint {
  if (!isBaseUnits(value)) throw new Error(`${label} must be a base-unit integer string`);
  return BigInt(value);
}

/**
 * Parses a non-negative decimal string into an integer scaled by 10^18. Digits beyond the scale
 * are rounded in the direction the caller names, so a comparison built on the result can only
 * ever err on the conservative side.
 */
function parseScaledDecimal(value: string, label: string, rounding: "floor" | "ceil"): bigint {
  if (!DECIMAL.test(value)) throw new Error(`${label} must be a non-negative decimal string`);
  const [whole, fraction = ""] = value.split(".");
  const kept = fraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0");
  const dropped = fraction.slice(DECIMAL_SCALE);
  let scaled = BigInt(whole!) * 10n ** BigInt(DECIMAL_SCALE) + BigInt(kept);
  if (rounding === "ceil" && /[1-9]/.test(dropped)) scaled += 1n;
  return scaled;
}

/** -1, 0, or 1 as `a` compares to `b`, both base-unit integer strings. */
export function compareBaseUnits(a: string, b: string): -1 | 0 | 1 {
  const x = parseBaseUnits(a, "a");
  const y = parseBaseUnits(b, "b");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Never more than the live balance: a full exit leaves no dust and never over-withdraws. */
export function clampToBalance(requested: string, balance: string): string {
  return compareBaseUnits(requested, balance) > 0 ? balance : requested;
}

/**
 * The floor a swap or LP withdrawal will accept, from a fresh quote and a slippage tolerance in
 * basis points. Rounds down: the floor protects the user, so it can only ever be conservative.
 * A quote too small to leave a positive floor yields "0", which the runner refuses - a floor of
 * nothing is no floor.
 */
export function minReceivedFromQuote(quoteAmount: string, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("slippageBps must be an integer in [0, 10000)");
  }
  const quote = parseBaseUnits(quoteAmount, "quoteAmount");
  return ((quote * BigInt(10_000 - slippageBps)) / 10_000n).toString();
}

export interface HealthInputs {
  /** Value of posted collateral, as a decimal string in any single unit (USD, or the debt asset). */
  collateralValue: string;
  /** Value of outstanding debt in the same unit. Zero means nothing to repay. */
  debtValue: string;
  /** The protocol's liquidation threshold for collateral/debt, in basis points (11000 = 110%). */
  minHealthFactorBps: number;
}

/** Whether the position carries any debt at all. */
export function hasDebt(inputs: HealthInputs): boolean {
  return parseScaledDecimal(inputs.debtValue, "debtValue", "ceil") > 0n;
}

/**
 * collateral / debt in basis points; null when there is no debt to be healthy against. Collateral
 * rounds down and debt rounds up, so the ratio never reads healthier than it is.
 */
export function healthFactorBps(inputs: HealthInputs): number | null {
  const debt = parseScaledDecimal(inputs.debtValue, "debtValue", "ceil");
  if (debt === 0n) return null;
  const collateral = parseScaledDecimal(inputs.collateralValue, "collateralValue", "floor");
  return Number((collateral * 10_000n) / debt);
}

/**
 * Repay-before-withdraw, second half: the position must be at or above the protocol's threshold
 * once the repay has happened - an exit that leaves it below is a liquidation, not a close.
 */
export function assessHealthFactor(inputs: HealthInputs): PlanBlocker[] {
  const hf = healthFactorBps(inputs);
  if (hf === null || hf >= inputs.minHealthFactorBps) return [];
  return [
    {
      code: "vault_undercollateralized",
      message:
        `This position's health factor (${(hf / 100).toFixed(2)}%) is below the ` +
        `${(inputs.minHealthFactorBps / 100).toFixed(2)}% liquidation threshold. ` +
        `Withdrawing collateral before repaying debt would push it toward liquidation.`,
    },
  ];
}

const WITHDRAW_BEFORE_REPAY: PlanBlocker = {
  code: "withdraw_before_repay",
  message:
    "This position has outstanding debt. Collateral cannot be withdrawn before the debt " +
    "is repaid.",
};

/**
 * Repay-before-withdraw, ordering: when a plan repays anything, every withdrawal-kind step must
 * come after the last repay. A plan with no repay is unconstrained here - `assessRepayPlanned`
 * is what decides whether a repay was owed at all.
 */
export function assessRepayBeforeWithdraw(kinds: readonly ExitStepKind[]): PlanBlocker[] {
  const lastRepay = kinds.lastIndexOf("repay");
  if (lastRepay === -1) return [];
  const early = kinds.findIndex((k, i) => i < lastRepay && WITHDRAWAL_KINDS.includes(k));
  return early === -1 ? [] : [WITHDRAW_BEFORE_REPAY];
}

/**
 * Repay-before-withdraw, obligation: a position that carries debt and plans to take value out
 * must plan a repay. An adapter that simply omits the repay is otherwise indistinguishable from
 * one whose position had no debt.
 */
export function assessRepayPlanned(
  health: HealthInputs,
  kinds: readonly ExitStepKind[]
): PlanBlocker[] {
  if (!hasDebt(health)) return [];
  const withdraws = kinds.some((k) => WITHDRAWAL_KINDS.includes(k));
  const repays = kinds.includes("repay");
  return withdraws && !repays ? [WITHDRAW_BEFORE_REPAY] : [];
}

export interface BackstopQueue {
  /** ISO timestamp the withdrawal was queued at, or null if it never was. */
  queuedForWithdrawalAt: string | null;
  /** The protocol's required cooldown between queuing and executing, in seconds. */
  cooldownSeconds: number;
}

/**
 * Blend's backstop cannot be exited on demand: a withdrawal is queued first (Q4W) and executes
 * only after the cooldown. A share never queued, or still cooling down, blocks rather than
 * pretending the exit can happen in this close. Anything unreadable fails closed.
 */
export function assessBackstopQueue(share: BackstopQueue, now: Date): PlanBlocker[] {
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
  if (
    !Number.isFinite(queuedAtMs) ||
    !Number.isFinite(share.cooldownSeconds) ||
    share.cooldownSeconds < 0
  ) {
    return [
      {
        code: "backstop_withdrawal_not_queued",
        message:
          "This backstop share's withdrawal queue could not be read, so its cooldown cannot be " +
          "confirmed. It cannot be withdrawn in this close.",
      },
    ];
  }
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
