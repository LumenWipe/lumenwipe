import type { PoolShareEntry } from "@/types/account";
import { formatAsset } from "@/lib/utils/assets";
import { stroopsToXlm, xlmToStroops } from "@/lib/utils/amounts";

/** One side of a pool withdrawal, as the analyze screen lists it. */
export interface PoolSideOutcome {
  code: string;
  /** The least the withdrawal will accept, in display units. */
  minimum: string;
  /** The account issues this asset, so the withdrawal retires it rather than paying it in. */
  retired: boolean;
}

export interface PoolWithdrawalOutcome {
  poolId: string;
  pair: string;
  shares: string;
  sides: [PoolSideOutcome, PoolSideOutcome];
}

// The API builds each minimum 1% under what the reserves give; shown here at the reserves the
// account read saw, which is also what verify() holds the built minimums to.
const SLIPPAGE_BPS = BigInt(100);

function minimumOf(shares: bigint, reserve: bigint, total: bigint): bigint {
  const given = total > BigInt(0) ? (shares * reserve) / total : BigInt(0);
  if (given <= BigInt(0)) return BigInt(0);
  const min = (given * (BigInt(10_000) - SLIPPAGE_BPS)) / BigInt(10_000);
  return min > BigInt(0) ? min : BigInt(1);
}

/** What withdrawing each pool the read could see into returns at least, for display only. */
export function poolWithdrawalOutcomes(
  poolShares: readonly PoolShareEntry[],
  address: string
): PoolWithdrawalOutcome[] {
  return poolShares.flatMap((share) => {
    const pool = share.pool;
    if (!pool) return [];
    const shares = BigInt(xlmToStroops(share.balance));
    const total = BigInt(pool.totalShares);
    const side = (asset: string, reserve: string): PoolSideOutcome => ({
      code: formatAsset(asset),
      minimum: stroopsToXlm(minimumOf(shares, BigInt(reserve), total)),
      retired: asset !== "native" && asset.split(":")[1] === address,
    });
    return [
      {
        poolId: share.poolId,
        pair: `${formatAsset(pool.assetA)}/${formatAsset(pool.assetB)}`,
        shares: share.balance,
        sides: [side(pool.assetA, pool.reserveA), side(pool.assetB, pool.reserveB)],
      },
    ];
  });
}
