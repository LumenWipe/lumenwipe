import {
  PoolContractV1,
  PoolContractV2,
  PoolV1,
  PoolV2,
  Positions,
  PositionsEstimate,
  RequestType,
  Version,
  type Network as BlendNetwork,
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
import { NETWORK_PASSPHRASES, RPC_HEADERS, RPC_URLS } from "@/config/networks";
import type { BuiltExitStep, ExitAdapter, ExitPlan, ExitStep } from "./adapter";
import type { HealthInputs } from "./invariants";
import { compareBaseUnits, isBaseUnits } from "./invariants";

/**
 * The Blend exit (architecture.md §9.3), through the official SDK's `Pool.submit` entry point.
 *
 * A Blend user holds one set of positions per pool - supply and collateral as bTokens, debt as
 * dTokens, each per reserve. Detection reports them one asset at a time, but they only exit
 * safely as a whole: the protocol rejects a collateral withdrawal that would leave debt
 * undercollateralized. So whichever Blend position this adapter is handed, it reads the user's
 * entire position in that pool and plans the whole exit - every repay first, then every
 * withdrawal - one `submit` request per step so each is simulated and verified on its own.
 * A caller iterating detected positions must therefore run this adapter once per pool, not once
 * per position; the wiring that owns that de-duplication is the plan builder's (#158).
 *
 * Amounts follow the protocol's two different rules. A withdrawal larger than the position clamps
 * down to what is held, so withdrawals over-ask by a small margin (`clampsToPosition`, bounded by
 * the runner) and leave no dust from the interest that accrues between the read and the ledger.
 * A repay is the opposite: the pool pulls the full stated amount and refunds any excess in the
 * same transaction, so a repay asks for the debt plus the same accrual margin and must be covered
 * in full by what the account holds of the debt asset. Anything less would be a partial repay
 * that strands the collateral behind leftover debt, so it blocks and says exactly what to acquire.
 * Acquiring it for the user (routing through a conversion, §10) is not done here; it waits on the
 * Soroban conversion work (#161), and until then the blocker is the honest answer.
 *
 * Reads go through the SDK for the version the registry resolved (V1 and V2 ship separate
 * clients), against the API's own RPC endpoint and headers; the runner's injected `rpc` is not
 * consulted here because the SDK builds its own server. Tests inject a stand-in pool through
 * `BlendDeps`. Anything the SDK cannot read or price surfaces as a named blocker for manual
 * review, not as a retry hint, because a pool the SDK cannot parse does not fix itself.
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
    const headers = RPC_HEADERS[network];
    const sdkNetwork: BlendNetwork = {
      rpc: RPC_URLS[network],
      passphrase: NETWORK_PASSPHRASES[network],
      ...(Object.keys(headers).length > 0 && { opts: { headers } }),
    };
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
      /** Kept so `health` can estimate the state a plan leaves, not just the state read. */
      pool: BlendPoolView;
      oracle: PoolOracle;
      raw: Positions;
    }
  | { status: "unsupported_version"; version: string }
  | { status: "not_pool"; kind: string }
  | { status: "unreadable" };

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

/** The accrual margin, rounded up so it is never rounded away on small positions. */
export function withAccrualMargin(amount: bigint): bigint {
  const scaled = amount * BigInt(10_000 + BLEND_ACCRUAL_BUFFER_BPS);
  return (scaled + 9_999n) / 10_000n;
}

function usd(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Blend estimate has no usable ${label}`);
  return value.toFixed(7);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function manualReview(code: string, message: string): ExitPlan {
  return { steps: [], blockers: [{ code, message }] };
}

export function blendExitAdapter(
  deps: BlendDeps = defaultBlendDeps
): ExitAdapter<BlendPosition, BlendLive> {
  return {
    protocol: "blend",

    supports(position: DefiPosition): position is BlendPosition {
      if (position.protocol !== "blend") return false;
      // Backstop deposits live in the backstop contract with their own queue rules (#155); this
      // adapter only knows pool supply, collateral, and debt.
      if (position.positionType === "supply") return !position.isBackstop;
      return position.positionType === "borrow";
    },

    async readLive(position, code, ctx): Promise<BlendLive> {
      if (code.kind !== "pool") return { status: "not_pool", kind: code.kind };
      const version = sdkVersion(code.version);
      if (version === null) return { status: "unsupported_version", version: code.version };

      try {
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
          if (!reserve) throw new Error(`position in a reserve the pool does not list: ${index}`);
          held.push({
            assetId: reserve.assetId,
            index,
            supply: reserve.toAssetFromBToken(positions.supply.get(index)),
            collateral: reserve.toAssetFromBToken(positions.collateral.get(index)),
            liabilities: reserve.toAssetFromDToken(positions.liabilities.get(index)),
          });
        }

        // Price every reserve now: an oracle gap is a reason to stop, not something to find out
        // about in health() after a plan has been drawn up.
        const current = deps.estimate(pool, oracle, positions);
        usd(current.totalEffectiveCollateral, "collateral value");
        usd(current.totalEffectiveLiabilities, "debt value");

        return {
          status: "loaded",
          version: pool.version,
          positions: held,
          pool,
          oracle,
          raw: positions,
        };
      } catch {
        return { status: "unreadable" };
      }
    },

    plan(position, live, code, ctx): ExitPlan {
      const pool = shortAddress(position.contractAddress);
      if (live.status === "not_pool") {
        return manualReview(
          "blend_contract_not_pool",
          `The Blend contract ${pool} holding this position is registered as a ${live.kind}, not a ` +
            "lending pool. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "unsupported_version") {
        return manualReview(
          "blend_pool_version_unsupported",
          `This Blend pool is registered as version "${live.version}", which LumenWipe has no client ` +
            "for. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "unreadable") {
        return manualReview(
          "blend_pool_unreadable",
          `The Blend pool ${pool} could not be read as a ${code.version} pool - its data, prices, ` +
            "or registry entry may be wrong. No exit was built; this position needs manual review."
        );
      }

      const steps: ExitStep[] = [];
      const blockers: ExitPlan["blockers"] = [];

      for (const held of live.positions) {
        if (held.liabilities === 0n) continue;
        const asset = shortAddress(held.assetId);
        const holding = ctx.tokenBalances[held.assetId];
        if (!isBaseUnits(holding)) {
          blockers.push({
            code: "blend_repay_asset_balance_unknown",
            message:
              `Repaying this Blend debt spends ${asset}, and LumenWipe could not determine how much ` +
              "of it the account holds. No exit was built; this position needs manual review.",
          });
          continue;
        }
        const ask = withAccrualMargin(held.liabilities).toString();
        if (compareBaseUnits(holding, ask) < 0) {
          const shortfall = BigInt(ask) - BigInt(holding);
          blockers.push({
            code: "blend_repay_asset_missing",
            message:
              `Repaying this Blend debt in full needs ${ask} base units of ${asset} (the debt plus a ` +
              `small margin for interest accrued before it lands) and the account holds ${holding} - ` +
              `${shortfall} short. Acquire the asset first; the pool refunds any excess.`,
          });
          continue;
        }
        steps.push({
          kind: "repay",
          contract: position.contractAddress,
          function: "submit",
          asset: held.assetId,
          amount: ask,
          ceiling: holding,
          minReceived: [],
          description: `Repay the ${asset} debt in Blend pool ${pool}`,
        });
      }
      if (blockers.length > 0) return { steps: [], blockers };

      // Collateral comes out before plain supply: once the debt is gone it is the riskier
      // balance to leave behind, and a fixed order keeps the plan deterministic.
      const withdrawal = (
        kind: "withdraw_collateral" | "withdraw",
        held: BlendReservePosition,
        underlying: bigint,
        what: string
      ): ExitStep => ({
        kind,
        contract: position.contractAddress,
        function: "submit",
        asset: held.assetId,
        amount: withAccrualMargin(underlying).toString(),
        ceiling: underlying.toString(),
        clampsToPosition: true,
        minReceived: [],
        description: `Withdraw the ${shortAddress(held.assetId)} ${what} from Blend pool ${pool}`,
      });
      for (const held of live.positions) {
        if (held.collateral > 0n) {
          steps.push(withdrawal("withdraw_collateral", held, held.collateral, "collateral"));
        }
      }
      for (const held of live.positions) {
        if (held.supply > 0n) steps.push(withdrawal("withdraw", held, held.supply, "supply"));
      }

      if (steps.length === 0) {
        return manualReview(
          "blend_position_gone",
          `The Blend position detected in pool ${pool} no longer shows any balance on the network. ` +
            "Re-run the analysis; if it persists, this position needs manual review."
        );
      }
      return { steps, blockers: [] };
    },

    health(_position, live, steps): HealthInputs | null {
      if (live.status !== "loaded") return null;
      if (live.positions.every((p) => p.liabilities === 0n)) return null;

      // The state the plan leaves before any withdrawal: liabilities the plan repays are gone,
      // anything it does not repay stays - so a plan missing a repay is visible as remaining debt.
      const repaid = new Set(steps.filter((s) => s.kind === "repay").map((s) => s.asset));
      const remaining = new Map<number, bigint>();
      for (const held of live.positions) {
        const dTokens = live.raw.liabilities.get(held.index);
        if (dTokens !== undefined && !repaid.has(held.assetId)) remaining.set(held.index, dTokens);
      }
      const after = deps.estimate(
        live.pool,
        live.oracle,
        new Positions(remaining, live.raw.collateral, live.raw.supply)
      );
      return {
        collateralValue: usd(after.totalEffectiveCollateral, "collateral value"),
        debtValue: usd(after.totalEffectiveLiabilities, "debt value"),
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
