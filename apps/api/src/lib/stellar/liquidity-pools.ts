import { Asset, xdr } from "@stellar/stellar-sdk";
import type { LiquidityPoolState } from "@lumenwipe/types";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { RPC_LEDGER_KEY_LIMIT } from "@/lib/stellar/live-ledger";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

export const LIQUIDITY_POOLS_LABEL = "The account's liquidity pools";

function assetString(asset: xdr.Asset): string {
  const decoded = Asset.fromOperation(asset);
  return decoded.isNative() ? "native" : `${decoded.getCode()}:${decoded.getIssuer()}`;
}

function poolKey(poolId: string): xdr.LedgerKey {
  return xdr.LedgerKey.liquidityPool(
    new xdr.LedgerKeyLiquidityPool({
      liquidityPoolId: xdr.PoolId.fromXdrObject(Buffer.from(poolId, "hex")),
    })
  );
}

/**
 * Each pool's ledger entry, by hex pool id, in as few RPC calls as the key limit allows. A pool the
 * ledger does not hold is absent; a failed or malformed read throws `LiveReadError`.
 */
export async function readLiquidityPools(
  server: LedgerReader,
  poolIds: readonly string[]
): Promise<Map<string, LiquidityPoolState>> {
  const ids = [...new Set(poolIds)];
  const byKey = new Map(ids.map((id) => [poolKey(id).toXDR("base64"), id]));
  const keys = ids.map(poolKey);
  const pools = new Map<string, LiquidityPoolState>();
  for (let i = 0; i < keys.length; i += RPC_LEDGER_KEY_LIMIT) {
    let entries: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>["entries"];
    try {
      entries = (await server.getLedgerEntries(...keys.slice(i, i + RPC_LEDGER_KEY_LIMIT))).entries;
    } catch {
      throw new LiveReadError(LIQUIDITY_POOLS_LABEL);
    }
    if (!Array.isArray(entries)) throw new LiveReadError(LIQUIDITY_POOLS_LABEL);
    for (const entry of entries) {
      const id = byKey.get(entry.key.toXDR("base64"));
      if (id === undefined || entry.val.type !== "liquidityPool") {
        throw new LiveReadError(LIQUIDITY_POOLS_LABEL);
      }
      const cp = entry.val.liquidityPool.body.constantProduct;
      pools.set(id, {
        assetA: assetString(cp.params.assetA),
        assetB: assetString(cp.params.assetB),
        fee: cp.params.fee,
        reserveA: cp.reserveA.toString(),
        reserveB: cp.reserveB.toString(),
        totalShares: cp.totalPoolShares.toString(),
      });
    }
  }
  return pools;
}
