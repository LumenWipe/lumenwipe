/**
 * A stand-in for the Blend SDK's pool, oracle, and estimate, shaped to what the adapter reads.
 *
 * Two reserves with fixed rates and prices, so every expected amount in the suite is a hand
 * computation: USDC (index 0, price 1) and XLM (index 1, price 0.1); bTokens convert at 1.05 and
 * dTokens at 1.02. Effective collateral applies a 0.9 collateral factor, effective liabilities a
 * 1.1 liability factor - the shape of Blend's math, not its real parameters.
 */
import { Positions, Version, type PoolOracle } from "@blend-capital/blend-sdk";
import type {
  BlendDeps,
  BlendEstimate,
  BlendPoolView,
  BlendReserveView,
} from "@/lib/defi-exits/blend";

export const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
export const XLM = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const PRICE: Record<string, number> = { [USDC]: 1, [XLM]: 0.1 };
const DECIMALS = 7;

function reserve(assetId: string, index: number): BlendReserveView {
  return {
    assetId,
    config: { index },
    toAssetFromBToken: (b) => ((b ?? 0n) * 105n) / 100n,
    toAssetFromDToken: (d) => ((d ?? 0n) * 102n) / 100n,
  };
}

export interface FakePoolState {
  version?: Version;
  /** bTokens per asset. */
  supply?: Record<string, bigint>;
  collateral?: Record<string, bigint>;
  /** dTokens per asset. */
  liabilities?: Record<string, bigint>;
}

const INDEX: Record<string, number> = { [USDC]: 0, [XLM]: 1 };

function toMap(amounts: Record<string, bigint> = {}): Map<number, bigint> {
  return new Map(Object.entries(amounts).map(([asset, amount]) => [INDEX[asset]!, amount]));
}

export function fakePool(state: FakePoolState = {}): BlendPoolView {
  const reserves = new Map<string, BlendReserveView>([
    [USDC, reserve(USDC, 0)],
    [XLM, reserve(XLM, 1)],
  ]);
  return {
    version: state.version ?? Version.V2,
    reserves,
    loadOracle: async () => ({}) as PoolOracle,
    loadUser: async () => ({
      positions: new Positions(
        toMap(state.liabilities),
        toMap(state.collateral),
        toMap(state.supply)
      ),
    }),
  };
}

/** Effective values in USD from underlying amounts and the fixed prices and factors above. */
export function fakeEstimate(
  pool: BlendPoolView,
  _oracle: PoolOracle,
  positions: Positions
): BlendEstimate {
  let collateral = 0;
  let liabilities = 0;
  for (const reserve of pool.reserves.values()) {
    const price = PRICE[reserve.assetId]!;
    const scale = 10 ** DECIMALS;
    const c =
      Number(reserve.toAssetFromBToken(positions.collateral.get(reserve.config.index))) / scale;
    const l =
      Number(reserve.toAssetFromDToken(positions.liabilities.get(reserve.config.index))) / scale;
    collateral += c * price * 0.9;
    liabilities += l * price * 1.1;
  }
  return { totalEffectiveCollateral: collateral, totalEffectiveLiabilities: liabilities };
}

export function fakeBlendDeps(state: FakePoolState = {}): BlendDeps & { loadCalls: string[] } {
  const loadCalls: string[] = [];
  return {
    loadCalls,
    async loadPool(_network, poolId, version) {
      loadCalls.push(`${poolId}@${version}`);
      return fakePool(state);
    },
    estimate: fakeEstimate,
  };
}

/** What a withdraw of `underlying` base units asks for, with the adapter's accrual buffer. */
export function withBuffer(underlying: bigint): string {
  return ((underlying * 10_010n + 9_999n) / 10_000n).toString();
}
