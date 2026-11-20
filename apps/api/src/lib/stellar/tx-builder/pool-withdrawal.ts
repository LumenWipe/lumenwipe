import { LiquidityPoolAsset, Operation, xdr } from "@stellar/stellar-sdk";
import type {
  AccountState,
  LiquidityPoolState,
  PlanBlocker,
  PoolShareEntry,
} from "@lumenwipe/types";
import { OP_BATCH_LIMIT } from "@/config/constants";
import { assetToSdkAsset, formatAsset } from "@/lib/utils/assets";
import { stroopsToFixedXlm, xlmToStroops } from "@/lib/utils/amounts";

/** How far below the amount the reserves give a withdrawal's minimum sits. */
export const POOL_WITHDRAW_SLIPPAGE_BPS = 100n;

/** Two operations per pool (the withdrawal and the line's removal), so a round is one transaction. */
export const POOL_ROUND_BATCH_SIZE = OP_BATCH_LIMIT / 2;

/** stellar-core's `getPoolWithdrawalAmount`: shares * reserve / total, rounded down. */
export function poolWithdrawalAmount(shares: bigint, reserve: bigint, total: bigint): bigint {
  if (total <= 0n) return 0n;
  return (shares * reserve) / total;
}

/** The least the withdrawal may return for a side the reserves give `expected` of. */
export function poolWithdrawalMinimum(expected: bigint): bigint {
  if (expected <= 0n) return 0n;
  const min = (expected * (10_000n - POOL_WITHDRAW_SLIPPAGE_BPS)) / 10_000n;
  return min > 0n ? min : 1n;
}

export interface PoolWithdrawal {
  poolId: string;
  /** In stroops. */
  shares: bigint;
  pool: LiquidityPoolState;
  expectedA: bigint;
  expectedB: bigint;
  minA: bigint;
  minB: bigint;
}

/** What withdrawing every share returns from `pool`, and the minimums held to it. */
export function planPoolWithdrawal(
  share: PoolShareEntry,
  pool: LiquidityPoolState
): PoolWithdrawal {
  const shares = BigInt(xlmToStroops(share.balance));
  const total = BigInt(pool.totalShares);
  const expectedA = poolWithdrawalAmount(shares, BigInt(pool.reserveA), total);
  const expectedB = poolWithdrawalAmount(shares, BigInt(pool.reserveB), total);
  return {
    poolId: share.poolId,
    shares,
    pool,
    expectedA,
    expectedB,
    minA: poolWithdrawalMinimum(expectedA),
    minB: poolWithdrawalMinimum(expectedB),
  };
}

/** The withdrawals of every pool the account read could see into. */
export function plannedPoolWithdrawals(
  account: Pick<AccountState, "poolShares">
): PoolWithdrawal[] {
  return account.poolShares.flatMap((share) =>
    share.pool ? [planPoolWithdrawal(share, share.pool)] : []
  );
}

/** A side the account itself issues: the withdrawal retires it rather than paying it in. */
export function isIssuedBy(asset: string, address: string): boolean {
  return asset !== "native" && asset.split(":")[1] === address;
}

/**
 * What `withdrawals` pay into the account's trustlines, per asset, at the reserves they were
 * planned at. XLM and the account's own assets are left out: neither lands in a trustline.
 */
export function proceedsPerAsset(
  withdrawals: readonly PoolWithdrawal[],
  address: string
): Map<string, bigint> {
  const proceeds = new Map<string, bigint>();
  for (const w of withdrawals) {
    for (const [asset, amount] of [
      [w.pool.assetA, w.expectedA],
      [w.pool.assetB, w.expectedB],
    ] as const) {
      if (asset === "native" || isIssuedBy(asset, address) || amount <= 0n) continue;
      proceeds.set(asset, (proceeds.get(asset) ?? 0n) + amount);
    }
  }
  return proceeds;
}

/** What every withdrawal the account read can plan pays in, per asset. */
export function poolProceedsPerAsset(
  account: Pick<AccountState, "address" | "poolShares">
): Map<string, bigint> {
  return proceedsPerAsset(plannedPoolWithdrawals(account), account.address);
}

/** `a` plus `b`, per asset. */
export function addAmounts(
  a: ReadonlyMap<string, bigint>,
  b: ReadonlyMap<string, bigint>
): Map<string, bigint> {
  const sum = new Map(a);
  for (const [asset, amount] of b) sum.set(asset, (sum.get(asset) ?? 0n) + amount);
  return sum;
}

function shortPoolId(poolId: string): string {
  return `${poolId.slice(0, 6)}…${poolId.slice(-6)}`;
}

/** "XLM/USDC", in the pool's own order. */
export function poolPairName(pool: LiquidityPoolState): string {
  return `${formatAsset(pool.assetA)}/${formatAsset(pool.assetB)}`;
}

function sideOutcome(asset: string, min: bigint, address: string): string {
  const code = formatAsset(asset);
  return isIssuedBy(asset, address)
    ? `${stroopsToFixedXlm(min)} ${code} returned to you as its issuer, which retires it`
    : `at least ${stroopsToFixedXlm(min)} ${code}`;
}

/** The plan's wording for one pool: the pool, the shares and the least of each side. */
export function poolWithdrawalLabels(
  w: PoolWithdrawal,
  address: string
): { title: string; description: string } {
  const pair = poolPairName(w.pool);
  const title = `Withdraw from the ${pair} pool`;
  if (w.shares === 0n) {
    return {
      title,
      description: `Remove the empty share trustline of the ${pair} pool (${shortPoolId(w.poolId)}).`,
    };
  }
  return {
    title,
    description:
      `Withdraw all ${stroopsToFixedXlm(w.shares)} shares of the ${pair} pool ` +
      `(${shortPoolId(w.poolId)}) and remove its share trustline. You receive ` +
      `${sideOutcome(w.pool.assetA, w.minA, address)} and ` +
      `${sideOutcome(w.pool.assetB, w.minB, address)}.`,
  };
}

/** The pool share line `pool` is held under. */
export function poolShareAsset(pool: LiquidityPoolState): LiquidityPoolAsset {
  return new LiquidityPoolAsset(
    assetToSdkAsset(pool.assetA),
    assetToSdkAsset(pool.assetB),
    pool.fee
  );
}

/**
 * Per pool: the withdrawal of every share (none for an empty line, which the ledger refuses as
 * malformed), then the removal of the share line, which the asset lines cannot be removed before.
 */
export function poolWithdrawalOps(withdrawals: PoolWithdrawal[]): xdr.Operation[] {
  return withdrawals.flatMap((w) => [
    ...(w.shares > 0n
      ? [
          Operation.liquidityPoolWithdraw({
            liquidityPoolId: w.poolId,
            amount: stroopsToFixedXlm(w.shares),
            minAmountA: stroopsToFixedXlm(w.minA),
            minAmountB: stroopsToFixedXlm(w.minB),
          }),
        ]
      : []),
    Operation.changeTrust({ asset: poolShareAsset(w.pool), limit: "0" }),
  ]);
}

export function poolWithdrawalOpCount(withdrawals: PoolWithdrawal[]): number {
  return withdrawals.reduce((n, w) => n + (w.shares > 0n ? 2 : 1), 0);
}

/**
 * The sides of `w` the account's trustlines could not take: a line the issuer only lets keep its
 * offers would receive the withdrawal and then hold it where it can be neither spent nor removed,
 * and a line whose limit, less its balance and what its open offers are buying, leaves less room
 * than the pool pays fails the withdrawal (LINE_FULL) every time it is built.
 */
export function poolSideBlockers(
  w: PoolWithdrawal,
  account: Pick<AccountState, "address" | "trustlines">
): PlanBlocker[] {
  const blockers: PlanBlocker[] = [];
  for (const [asset, expected] of [
    [w.pool.assetA, w.expectedA],
    [w.pool.assetB, w.expectedB],
  ] as const) {
    if (asset === "native" || isIssuedBy(asset, account.address) || expected <= 0n) continue;
    const code = formatAsset(asset);
    const tl = account.trustlines.find((t) => t.asset === asset);
    if (!tl || tl.authorization !== "authorized") {
      blockers.push({
        code: "liquidity_pool_shares_held",
        message:
          `Withdrawing from the ${poolPairName(w.pool)} pool would pay ${code} into a ` +
          "trustline its issuer has not fully authorized, where it could not be sold, sent or " +
          "removed. Ask the issuer to restore authorization, then plan again.",
      });
      continue;
    }
    if (tl.limit === undefined) continue;
    const room =
      BigInt(xlmToStroops(tl.limit)) -
      BigInt(xlmToStroops(tl.balance)) -
      BigInt(xlmToStroops(tl.buyingLiabilities ?? "0"));
    if (room < expected) {
      blockers.push({
        code: "liquidity_pool_shares_held",
        message:
          `Withdrawing from the ${poolPairName(w.pool)} pool would pay ` +
          `${stroopsToFixedXlm(expected)} ${code}, more than the ${code} trustline has room for ` +
          "under its limit once its open offers to buy it are counted. Cancel those offers or " +
          "raise the limit, then plan again.",
      });
    }
  }
  return blockers;
}

/** The pool shares the close cannot withdraw: a pool the read could not see into, or a side
 *  `poolSideBlockers` refuses. */
export function assessPoolShareBlockers(
  account: Pick<AccountState, "address" | "poolShares" | "trustlines">
): PlanBlocker[] {
  return account.poolShares.flatMap((share) =>
    share.pool
      ? poolSideBlockers(planPoolWithdrawal(share, share.pool), account)
      : [
          {
            code: "liquidity_pool_shares_held",
            message:
              `The liquidity pool ${shortPoolId(share.poolId)} this account holds shares in ` +
              "could not be read, so its withdrawal cannot be planned. Analyze the account again.",
          },
        ]
  );
}
