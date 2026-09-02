import { describe, expect, test } from "bun:test";
import {
  assessBackstopQueue,
  assessHealthFactor,
  assessRepayBeforeWithdraw,
  clampToBalance,
  compareBaseUnits,
  healthFactorBps,
  minReceivedFromQuote,
} from "@/lib/defi-exits";

describe("base-unit arithmetic", () => {
  test("compares exactly, beyond float precision", () => {
    expect(compareBaseUnits("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareBaseUnits("10", "10")).toBe(0);
    expect(compareBaseUnits("9", "10")).toBe(-1);
  });

  test("rejects anything that is not an integer string", () => {
    expect(() => compareBaseUnits("1.5", "1")).toThrow("base-unit integer string");
    expect(() => compareBaseUnits("-1", "1")).toThrow("base-unit integer string");
    expect(() => compareBaseUnits("", "1")).toThrow("base-unit integer string");
  });

  test("clampToBalance never exceeds the balance and never rounds a smaller request up", () => {
    expect(clampToBalance("500", "300")).toBe("300");
    expect(clampToBalance("200", "300")).toBe("200");
    expect(clampToBalance("300", "300")).toBe("300");
  });

  test("minReceivedFromQuote floors, so the bound is always conservative", () => {
    expect(minReceivedFromQuote("1000000000", 50)).toBe("995000000");
    // 999 * 0.995 = 994.005 -> 994, never 995
    expect(minReceivedFromQuote("999", 50)).toBe("994");
    expect(minReceivedFromQuote("999", 0)).toBe("999");
  });

  test("minReceivedFromQuote rejects a slippage that would zero or negate the floor", () => {
    expect(() => minReceivedFromQuote("1000", 10_000)).toThrow("slippageBps");
    expect(() => minReceivedFromQuote("1000", -1)).toThrow("slippageBps");
    expect(() => minReceivedFromQuote("1000", 0.5)).toThrow("slippageBps");
  });
});

describe("health factor", () => {
  const inputs = (collateralValue: string, debtValue = "100") => ({
    collateralValue,
    debtValue,
    minHealthFactorBps: 11_000,
  });

  test("is collateral over debt in basis points, floored", () => {
    expect(healthFactorBps(inputs("150"))).toBe(15_000);
    expect(healthFactorBps(inputs("110.999"))).toBe(11_099);
  });

  test("is null with no debt - nothing to be healthy against", () => {
    expect(healthFactorBps(inputs("150", "0"))).toBeNull();
    expect(assessHealthFactor(inputs("150", "0"))).toEqual([]);
  });

  test("a healthy position is not blocked, and the threshold itself is safe", () => {
    expect(assessHealthFactor(inputs("150"))).toEqual([]);
    expect(assessHealthFactor(inputs("110"))).toEqual([]);
  });

  test("an undercollateralized position is blocked with the liquidation explanation", () => {
    const blockers = assessHealthFactor(inputs("105"));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.code).toBe("vault_undercollateralized");
    expect(blockers[0]!.message).toContain("105.00%");
    expect(blockers[0]!.message).toContain("110.00%");
  });

  test("rejects malformed values instead of computing on NaN", () => {
    expect(() => healthFactorBps(inputs("abc"))).toThrow("collateralValue");
    expect(() => healthFactorBps(inputs("150", "-1"))).toThrow("debtValue");
  });
});

describe("repay before withdraw", () => {
  test("a plan with no repay is unconstrained", () => {
    expect(assessRepayBeforeWithdraw(["withdraw", "claim"])).toEqual([]);
    expect(assessRepayBeforeWithdraw([])).toEqual([]);
  });

  test("repay then withdraw is fine; any withdrawal kind ahead of a repay is blocked", () => {
    expect(assessRepayBeforeWithdraw(["repay", "withdraw"])).toEqual([]);
    expect(assessRepayBeforeWithdraw(["repay", "repay", "withdraw_collateral"])).toEqual([]);
    for (const early of [
      "withdraw",
      "withdraw_collateral",
      "remove_liquidity",
      "unstake",
    ] as const) {
      const blockers = assessRepayBeforeWithdraw([early, "repay"]);
      expect(blockers.map((b) => b.code)).toEqual(["withdraw_before_repay"]);
    }
  });

  test("a withdrawal between two repays is still ahead of a repay, so it is blocked", () => {
    expect(assessRepayBeforeWithdraw(["repay", "withdraw", "repay"]).map((b) => b.code)).toEqual([
      "withdraw_before_repay",
    ]);
  });

  test("a claim ahead of a repay is not a withdrawal and is allowed", () => {
    expect(assessRepayBeforeWithdraw(["claim", "repay", "withdraw"])).toEqual([]);
  });
});

describe("backstop queue (Q4W)", () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const cooldownSeconds = 17 * 24 * 60 * 60;

  test("a share never queued is blocked", () => {
    const blockers = assessBackstopQueue({ queuedForWithdrawalAt: null, cooldownSeconds }, now);
    expect(blockers.map((b) => b.code)).toEqual(["backstop_withdrawal_not_queued"]);
  });

  test("a share queued but still cooling down is blocked, with the remaining time", () => {
    const queuedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const blockers = assessBackstopQueue({ queuedForWithdrawalAt: queuedAt, cooldownSeconds }, now);
    expect(blockers.map((b) => b.code)).toEqual(["backstop_withdrawal_cooling_down"]);
    expect(blockers[0]!.message).toContain(`${7 * 24 * 60 * 60} second(s) remain`);
  });

  test("a share queued exactly at the cooldown boundary is exitable", () => {
    const queuedAt = new Date(now.getTime() - cooldownSeconds * 1000).toISOString();
    expect(assessBackstopQueue({ queuedForWithdrawalAt: queuedAt, cooldownSeconds }, now)).toEqual(
      []
    );
  });

  test("an unparseable queue time is treated as not queued, never as exitable", () => {
    const blockers = assessBackstopQueue(
      { queuedForWithdrawalAt: "yesterday-ish", cooldownSeconds },
      now
    );
    expect(blockers.map((b) => b.code)).toEqual(["backstop_withdrawal_not_queued"]);
  });
});
