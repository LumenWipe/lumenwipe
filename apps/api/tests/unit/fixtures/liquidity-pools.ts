import { Asset, LiquidityPoolFeeV18, getLiquidityPoolId, rpc, xdr } from "@stellar/stellar-sdk";
import type { LiquidityPoolState, PoolShareEntry } from "@lumenwipe/types";
import { assetToSdkAsset } from "@/lib/utils/assets";

/** The hex id of the classic pool of `assetA` and `assetB`, which must be in the pool's order. */
export function poolIdOf(assetA: string, assetB: string): string {
  return Buffer.from(
    getLiquidityPoolId("constant_product", {
      assetA: assetToSdkAsset(assetA),
      assetB: assetToSdkAsset(assetB),
      fee: LiquidityPoolFeeV18,
    })
  ).toString("hex");
}

export function poolState(
  assetA: string,
  assetB: string,
  reserveA: bigint,
  reserveB: bigint,
  totalShares: bigint
): LiquidityPoolState {
  return {
    assetA,
    assetB,
    fee: LiquidityPoolFeeV18,
    reserveA: reserveA.toString(),
    reserveB: reserveB.toString(),
    totalShares: totalShares.toString(),
  };
}

export function poolShare(pool: LiquidityPoolState, balance: string): PoolShareEntry {
  return { poolId: poolIdOf(pool.assetA, pool.assetB), balance, pool };
}

/** The ledger's answer for `pool`'s key, as `getLedgerEntries` returns it. */
export function poolLedgerEntry(pool: LiquidityPoolState): rpc.Api.LedgerEntryResult {
  const liquidityPoolId = xdr.PoolId.fromXdrObject(
    Buffer.from(poolIdOf(pool.assetA, pool.assetB), "hex")
  );
  const toXdr = (asset: string): xdr.Asset =>
    (asset === "native" ? Asset.native() : assetToSdkAsset(asset)).toXDRObject();
  return {
    key: xdr.LedgerKey.liquidityPool(new xdr.LedgerKeyLiquidityPool({ liquidityPoolId })),
    lastModifiedLedgerSeq: 1000,
    val: xdr.LedgerEntryData.liquidityPool(
      new xdr.LiquidityPoolEntry({
        liquidityPoolId,
        body: xdr.LiquidityPoolEntryBody.liquidityPoolConstantProduct(
          new xdr.LiquidityPoolEntryConstantProduct({
            params: new xdr.LiquidityPoolConstantProductParameters({
              assetA: toXdr(pool.assetA),
              assetB: toXdr(pool.assetB),
              fee: pool.fee,
            }),
            reserveA: BigInt(pool.reserveA),
            reserveB: BigInt(pool.reserveB),
            totalPoolShares: BigInt(pool.totalShares),
            poolSharesTrustLineCount: 1n,
          })
        ),
      })
    ),
  };
}

/** Answers liquidity pool keys from `pools` and hands every other key to `rest`. */
export function withPools(
  pools: LiquidityPoolState[],
  rest: rpc.Server["getLedgerEntries"]
): rpc.Server["getLedgerEntries"] {
  return async (...keys) => {
    const poolKeys = keys.filter((k) => k.type === "liquidityPool");
    const others = keys.filter((k) => k.type !== "liquidityPool");
    const wanted = new Set(poolKeys.map((k) => k.toXDR("base64")));
    const entries = pools.map(poolLedgerEntry).filter((e) => wanted.has(e.key.toXDR("base64")));
    if (others.length === 0) return { latestLedger: 1000, entries };
    const answered = await rest(...others);
    return { ...answered, entries: [...entries, ...answered.entries] };
  };
}
