/**
 * A stand-in for the Blend SDK's pool, oracle, estimate, emissions, and backstop, shaped to what
 * the adapter reads.
 *
 * Two reserves with fixed rates and prices, so every expected amount in the suite is a hand
 * computation: USDC (index 0, price 1) and XLM (index 1, price 0.1); bTokens convert at 1.05 and
 * dTokens at 1.02. Effective collateral applies a 0.9 collateral factor, effective liabilities a
 * 1.1 liability factor - the shape of Blend's math, not its real parameters. Emissions and the
 * backstop deposit are given directly as what the SDK would have computed.
 */
import { Positions, Version, type PoolOracle } from "@blend-capital/blend-sdk";
import type {
  BlendBackstopView,
  BlendDeps,
  BlendEmissionsView,
  BlendEstimate,
  BlendPoolView,
  BlendReserveView,
} from "@/lib/defi-exits/blend";

export const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
export const XLM = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
/** The registry's Blend V2 testnet backstop, and stand-ins for its two tokens. */
export const BACKSTOP = "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA";
export const BACKSTOP_TOKEN = "CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM";
export const BLND = "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF";

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
  /** Claimable BLND per reserve token id, and the position's accrual rate (scaled). */
  emissions?: { claimable: Record<number, bigint>; rateScaled?: bigint };
  /** The account's backstop deposit for this pool; absent means none. */
  backstop?: {
    shares?: bigint;
    queued?: Array<{ amount: bigint; unlocksAt: number }>;
    unlocked?: bigint;
    /** BLND accrued to the deposit, base units. */
    emissions?: bigint;
  };
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
    metadata: { backstop: BACKSTOP },
    reserves,
    loadOracle: async () => ({}) as PoolOracle,
    loadUser: async () => ({
      positions: new Positions(
        toMap(state.liabilities),
        toMap(state.collateral),
        toMap(state.supply)
      ),
      emissions: new Map(),
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

export function fakeBlendDeps(
  state: FakePoolState = {}
): BlendDeps & { loadCalls: string[]; backstopCalls: string[] } {
  const loadCalls: string[] = [];
  const backstopCalls: string[] = [];
  return {
    loadCalls,
    backstopCalls,
    async loadPool(_network, poolId, version) {
      loadCalls.push(`${poolId}@${version}`);
      return fakePool(state);
    },
    estimate: fakeEstimate,
    emissions(): BlendEmissionsView {
      return {
        claimable: new Map(
          Object.entries(state.emissions?.claimable ?? {}).map(([id, v]) => [Number(id), v])
        ),
        rateScaled: state.emissions?.rateScaled ?? 0n,
      };
    },
    async loadBackstop(
      _network,
      _version,
      backstopId,
      poolId,
      account
    ): Promise<BlendBackstopView> {
      backstopCalls.push(`${backstopId}/${poolId}/${account}`);
      return {
        contract: backstopId,
        backstopToken: BACKSTOP_TOKEN,
        blndToken: BLND,
        shares: state.backstop?.shares ?? 0n,
        queued: state.backstop?.queued ?? [],
        unlocked: state.backstop?.unlocked ?? 0n,
        emissions: state.backstop?.emissions ?? 0n,
      };
    },
  };
}
