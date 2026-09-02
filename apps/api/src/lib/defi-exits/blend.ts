import {
  PoolContractV1,
  PoolContractV2,
  PoolV1,
  PoolV2,
  Positions,
  PositionsEstimate,
  RequestType,
  Version,
  type Pool,
  type PoolOracle,
} from "@blend-capital/blend-sdk";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  Network,
} from "@lumenwipe/types";
import { xdr } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, RPC_URLS } from "@/config/networks";
import type { BuiltExitStep, ExitAdapter, ExitPlan, ExitStep } from "./adapter";
import type { HealthInputs } from "./invariants";
import { compareBaseUnits } from "./invariants";

/**
 * The Blend exit (architecture.md §9.3), through the official SDK's `Pool.submit` entry point.
 *
 * A Blend user holds one set of positions per pool - supply and collateral as bTokens, debt as
 * dTokens, each per reserve. Detection reports them one asset at a time, but they only exit
 * safely as a whole: the protocol rejects a collateral withdrawal that would leave debt
 * undercollateralized. So whichever Blend position this adapter is handed, it reads the user's
 * entire position in that pool and plans the whole exit - every repay first, then every
 * withdrawal - one `submit` request per step so each is simulated and verified on its own.
 *
 * Amounts follow the protocol's two different rules. A withdrawal larger than the position clamps
 * down to what is held, so withdrawals over-ask by a small margin and leave no dust from the
 * interest that accrues between the read and the ledger. A repay is the opposite: the pool pulls
 * the full stated amount and refunds any excess in the same transaction, so a repay is capped at
 * what the account actually holds of the debt asset - and when that is short, the exit blocks
 * and says what to acquire rather than repaying partially and leaving the position mid-air.
 *
 * Reads go through the SDK for the version the registry resolved (V1 and V2 ship separate
 * clients), against the API's own RPC endpoint; the runner's injected `rpc` is not consulted here
 * because the SDK builds its own server. Tests inject a stand-in pool through `BlendDeps`.
 */

export type BlendPosition = BlendSupplyPosition | BlendBorrowPosition;

/** Interest accrues between the live read and the ledger; a withdraw over-asks by this much and
 *  the protocol clamps it, a repay over-asks by this much and the protocol refunds it. */
export const BLEND_ACCRUAL_BUFFER_BPS = 10;

/** Blend liquidates below a health factor of 1.0: effective collateral must cover effective debt. */
export const BLEND_MIN_HEALTH_FACTOR_BPS = 10_000;

/** The slice of the SDK's reserve the adapter reads, so a test can supply a stand-in. */
export interface BlendReserveView {
  assetId: string;
  config: { index: number };
  toAssetFromBToken(bTokens: bigint | undefined): bigint;
  toAssetFromDToken(dTokens: bigint | undefined): bigint;
}

/** The slice of the SDK's pool the adapter reads. */
export interface BlendPoolView {
  version: Version;
  reserves: Map<string, BlendReserveView>;
  loadOracle(): Promise<PoolOracle>;
  loadUser(userId: string): Promise<{ positions: Positions }>;
}

export interface BlendEstimate {
  totalEffectiveCollateral: number;
  totalEffectiveLiabilities: number;
}

export interface BlendDeps {
  loadPool(network: Network, poolId: string, version: Version): Promise<BlendPoolView>;
  estimate(pool: BlendPoolView, oracle: PoolOracle, positions: Positions): BlendEstimate;
}

export const defaultBlendDeps: BlendDeps = {
  loadPool(network, poolId, version) {
    const sdkNetwork = { rpc: RPC_URLS[network], passphrase: NETWORK_PASSPHRASES[network] };
    return version === Version.V1
      ? PoolV1.load(sdkNetwork, poolId)
      : PoolV2.load(sdkNetwork, poolId);
  },
  estimate(pool, oracle, positions) {
    // The real pool is a real SDK Pool; the view type only narrows what the adapter touches.
    return PositionsEstimate.build(pool as Pool, oracle, positions);
  },
};

export interface BlendReservePosition {
  assetId: string;
  index: number;
  /** Underlying amounts, base units, from the SDK's live bToken/dToken rates. */
  supply: bigint;
  collateral: bigint;
  liabilities: bigint;
}

export type BlendLive =
  | {
      status: "loaded";
      version: Version;
      positions: BlendReservePosition[];
      /** Health of the position as it stands. */
      current: BlendEstimate;
      /** Health once every liability is repaid - the state a plan leaves before withdrawing. */
      afterRepay: BlendEstimate;
    }
  | { status: "unsupported_version"; version: string };

const REQUEST_TYPE: Record<"repay" | "withdraw" | "withdraw_collateral", RequestType> = {
  repay: RequestType.Repay,
  withdraw: RequestType.Withdraw,
  withdraw_collateral: RequestType.WithdrawCollateral,
};

function sdkVersion(registryVersion: string): Version | null {
  const normalized = registryVersion.trim().toLowerCase();
  if (normalized === "v1") return Version.V1;
  if (normalized === "v2") return Version.V2;
  return null;
}

function overAsk(amount: bigint): bigint {
  // Ceiling division, so the buffer is never rounded away on small positions.
  const scaled = amount * BigInt(10_000 + BLEND_ACCRUAL_BUFFER_BPS);
  return (scaled + 9_999n) / 10_000n;
}

function usd(value: number): string {
  return Math.max(0, value).toFixed(7);
}

function shortAsset(assetId: string): string {
  return `${assetId.slice(0, 4)}…${assetId.slice(-4)}`;
}

export function blendExitAdapter(
  deps: BlendDeps = defaultBlendDeps
): ExitAdapter<BlendPosition, BlendLive> {
  return {
    protocol: "blend",

    supports(position: DefiPosition): position is BlendPosition {
      return (
        position.protocol === "blend" &&
        (position.positionType === "supply" || position.positionType === "borrow")
      );
    },

    async readLive(position, code, ctx): Promise<BlendLive> {
      const version = sdkVersion(code.version);
      if (version === null) return { status: "unsupported_version", version: code.version };

      const pool = await deps.loadPool(ctx.network, position.contractAddress, version);
      const [oracle, user] = await Promise.all([pool.loadOracle(), pool.loadUser(ctx.account)]);
      const { positions } = user;

      const byIndex = new Map<number, BlendReserveView>();
      for (const reserve of pool.reserves.values()) byIndex.set(reserve.config.index, reserve);

      const indices = new Set<number>([
        ...positions.supply.keys(),
        ...positions.collateral.keys(),
        ...positions.liabilities.keys(),
      ]);
      const held: BlendReservePosition[] = [];
      for (const index of [...indices].sort((a, b) => a - b)) {
        const reserve = byIndex.get(index);
        if (!reserve) throw new Error(`Blend pool reports a position in unknown reserve ${index}`);
        held.push({
          assetId: reserve.assetId,
          index,
          supply: reserve.toAssetFromBToken(positions.supply.get(index)),
          collateral: reserve.toAssetFromBToken(positions.collateral.get(index)),
          liabilities: reserve.toAssetFromDToken(positions.liabilities.get(index)),
        });
      }

      const repaid = new Positions(new Map(), positions.collateral, positions.supply);
      return {
        status: "loaded",
        version: pool.version,
        positions: held,
        current: deps.estimate(pool, oracle, positions),
        afterRepay: deps.estimate(pool, oracle, repaid),
      };
    },

    plan(position, live, code, ctx): ExitPlan {
      const pool = position.contractAddress;
      if (live.status === "unsupported_version") {
        return {
          steps: [],
          blockers: [
            {
              code: "blend_pool_version_unsupported",
              message:
                `This Blend pool is registered as version "${live.version}", which LumenWipe has no ` +
                "client for. No exit was built; this position needs manual review.",
            },
          ],
        };
      }
      if (code.kind !== "pool") {
        return {
          steps: [],
          blockers: [
            {
              code: "blend_contract_not_pool",
              message:
                `The Blend contract ${shortAsset(pool)} holding this position is registered as a ` +
                `${code.kind}, not a lending pool. No exit was built; this position needs manual review.`,
            },
          ],
        };
      }
      const expected = sdkVersion(code.version);
      if (live.version !== expected) {
        return {
          steps: [],
          blockers: [
            {
              code: "blend_pool_version_mismatch",
              message:
                `The Blend pool ${shortAsset(pool)} reports itself as ${live.version} but the ` +
                `registry lists it as ${code.version}. No exit was built; this position needs manual review.`,
            },
          ],
        };
      }

      const steps: ExitStep[] = [];
      const blockers: ExitPlan["blockers"] = [];

      for (const held of live.positions) {
        if (held.liabilities === 0n) continue;
        const holding = ctx.tokenBalances[held.assetId] ?? "0";
        const debt = held.liabilities.toString();
        if (compareBaseUnits(holding, debt) < 0) {
          const shortfall = held.liabilities - BigInt(holding);
          blockers.push({
            code: "blend_repay_asset_missing",
            message:
              `Repaying this Blend debt needs ${debt} base units of ${shortAsset(held.assetId)} and ` +
              `the account holds ${holding} - ${shortfall} short. Acquire the asset first; the pool ` +
              "refunds any excess, so nothing is lost by holding a little more.",
          });
          continue;
        }
        const ask = overAsk(held.liabilities);
        const amount = compareBaseUnits(ask.toString(), holding) > 0 ? holding : ask.toString();
        steps.push({
          kind: "repay",
          contract: pool,
          function: "submit",
          asset: held.assetId,
          amount,
          ceiling: holding,
          minReceived: [],
          description: `Repay the ${shortAsset(held.assetId)} debt in Blend pool ${shortAsset(pool)}`,
        });
      }
      if (blockers.length > 0) return { steps: [], blockers };

      // Collateral comes out before plain supply: once the debt is gone it is the riskier
      // balance to leave behind, and a fixed order keeps the plan deterministic.
      for (const held of live.positions) {
        if (held.collateral === 0n) continue;
        const ask = overAsk(held.collateral).toString();
        steps.push({
          kind: "withdraw_collateral",
          contract: pool,
          function: "submit",
          asset: held.assetId,
          amount: ask,
          ceiling: ask,
          minReceived: [],
          description: `Withdraw the ${shortAsset(held.assetId)} collateral from Blend pool ${shortAsset(pool)}`,
        });
      }
      for (const held of live.positions) {
        if (held.supply === 0n) continue;
        const ask = overAsk(held.supply).toString();
        steps.push({
          kind: "withdraw",
          contract: pool,
          function: "submit",
          asset: held.assetId,
          amount: ask,
          ceiling: ask,
          minReceived: [],
          description: `Withdraw the ${shortAsset(held.assetId)} supply from Blend pool ${shortAsset(pool)}`,
        });
      }

      if (steps.length === 0) {
        return {
          steps: [],
          blockers: [
            {
              code: "blend_position_gone",
              message:
                `The Blend position detected in pool ${shortAsset(pool)} no longer shows any balance ` +
                "on the network. Re-run the analysis; if it persists, this position needs manual review.",
            },
          ],
        };
      }
      return { steps, blockers: [] };
    },

    health(_position, live): HealthInputs | null {
      if (live.status !== "loaded") return null;
      if (live.positions.every((p) => p.liabilities === 0n)) return null;
      return {
        collateralValue: usd(live.afterRepay.totalEffectiveCollateral),
        debtValue: usd(live.afterRepay.totalEffectiveLiabilities),
        minHealthFactorBps: BLEND_MIN_HEALTH_FACTOR_BPS,
      };
    },

    buildStep(step, live, ctx): BuiltExitStep {
      if (live.status !== "loaded") throw new Error("Blend: cannot build against an unloaded pool");
      if (
        step.kind !== "repay" &&
        step.kind !== "withdraw" &&
        step.kind !== "withdraw_collateral"
      ) {
        throw new Error(`Blend: no submit request for a ${step.kind} step`);
      }
      const client =
        live.version === Version.V1
          ? new PoolContractV1(step.contract)
          : new PoolContractV2(step.contract);
      const requestType = REQUEST_TYPE[step.kind];
      const opXdr = client.submit({
        from: ctx.account,
        spender: ctx.account,
        to: ctx.account,
        requests: [{ request_type: requestType, address: step.asset, amount: BigInt(step.amount) }],
      });
      return {
        step,
        build: { source: "local", op: xdr.Operation.fromXDR(opXdr, "base64") },
        intent: {
          contract: step.contract,
          function: "submit",
          args: [RequestType[requestType], step.asset, step.amount, ctx.account],
          minReceived: [],
          recipient: ctx.account,
        },
      };
    },
  };
}
