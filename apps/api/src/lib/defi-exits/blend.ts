import {
  BackstopConfig,
  BackstopContractV1,
  BackstopContractV2,
  BackstopPoolUser,
  BackstopPoolV1,
  BackstopPoolV2,
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
  type PoolUser,
} from "@blend-capital/blend-sdk";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPosition,
  Network,
} from "@lumenwipe/types";
import { xdr } from "@stellar/stellar-sdk";
import { blendSdkNetwork, blendSdkVersion } from "@/lib/blend-sdk";
import {
  EXIT_POSITION_GONE,
  type BuiltExitStep,
  type ExitAdapter,
  type ExitPlan,
  type ExitStep,
} from "./adapter";
import type { HealthInputs } from "./invariants";
import { compareBaseUnits, isBaseUnits } from "./invariants";
import { REWARD_RATE_SCALE, rewardIsWorthClaiming } from "./reward-dust";

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
 * Two more things the pool owes the account leave with it (#155). BLND emissions accrue to every
 * supplied, collateralized, and borrowed balance and are paid only on request: they are read
 * through the SDK's emission data and claimed first, as their own `claim` call, whenever they are
 * older than the close itself (see reward-dust.ts) - a merged account can never come back for
 * them. And the pool's backstop holds deposits the account may have made (the BLND:USDC LP share,
 * detected as `isBackstop`), which cannot be exited on demand: Blend requires queuing a withdrawal
 * and waiting out a cooldown (21 days on V1, 17 on V2). Shares whose queue has run out are
 * withdrawn as a step against the backstop contract - once the close can carry the LP token they
 * pay out in; until then they block, as do shares still cooling down or never queued, each by
 * name with the time left, because a merge would forfeit them. A cooldown the tool cannot skip is
 * a reason to wait, not to lose the deposit. BLND emissions accrued to the deposit itself block
 * too: the backstop's own claim re-deposits them on V2 rather than paying them out.
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

/** Blend's queue-for-withdrawal cooldown per protocol version, in seconds. */
export const BACKSTOP_COOLDOWN_SECONDS: Record<Version, number> = {
  [Version.V1]: 21 * 24 * 60 * 60,
  [Version.V2]: 17 * 24 * 60 * 60,
};

/** BLND is tracked in 7 decimals on every network Blend runs on. */
const BLND_DECIMALS = 7;
const BLND_SCALE = 10n ** BigInt(BLND_DECIMALS);

/** The slice of the SDK's reserve the adapter reads, so a test can supply a stand-in. */
export interface BlendReserveView {
  assetId: string;
  config: { index: number };
  toAssetFromBToken(bTokens: bigint | undefined): bigint;
  toAssetFromDToken(dTokens: bigint | undefined): bigint;
}

/** The slice of the SDK's pool user the adapter reads. */
export interface BlendUserView {
  positions: Positions;
  /** Per reserve token id (`index × 2` for the dToken, `+ 1` for the bToken). */
  emissions: Map<number, { index: bigint; accrued: bigint }>;
}

/** The slice of the SDK's pool the adapter reads. */
export interface BlendPoolView {
  version: Version;
  metadata: { backstop: string };
  reserves: Map<string, BlendReserveView>;
  loadOracle(): Promise<PoolOracle>;
  loadUser(userId: string): Promise<BlendUserView>;
}

export interface BlendEstimate {
  totalEffectiveCollateral: number;
  totalEffectiveLiabilities: number;
}

/** What the pool owes the account in BLND, per reserve token id, and how fast it grows. */
export interface BlendEmissionsView {
  claimable: Map<number, bigint>;
  /** BLND base units × REWARD_RATE_SCALE per second at the current emission rates; 0 once expired. */
  rateScaled: bigint;
}

/** The account's deposit in the pool's backstop, as the backstop contract keeps it. */
export interface BlendBackstopView {
  contract: string;
  /** The backstop's deposit token (the BLND:USDC LP share) and the BLND token it pays emissions in. */
  backstopToken: string;
  blndToken: string;
  /** Shares deposited and not queued for withdrawal. */
  shares: bigint;
  /** Queued withdrawals still cooling down, with the time each unlocks (seconds since the epoch). */
  queued: Array<{ amount: bigint; unlocksAt: number }>;
  /** Queued shares whose cooldown has run out: withdrawable now. */
  unlocked: bigint;
  /** BLND emissions accrued to the deposit and not claimed, base units. */
  emissions: bigint;
}

export interface BlendDeps {
  loadPool(network: Network, poolId: string, version: Version): Promise<BlendPoolView>;
  estimate(pool: BlendPoolView, oracle: PoolOracle, positions: Positions): BlendEstimate;
  emissions(pool: BlendPoolView, user: BlendUserView, now: number): BlendEmissionsView;
  loadBackstop(
    network: Network,
    version: Version,
    backstopId: string,
    poolId: string,
    account: string,
    now: number
  ): Promise<BlendBackstopView>;
}

/**
 * One emitting token of a reserve - its dToken or its bToken - as Blend accounts for it: an
 * emission index the token's supply accrues against, the account's last index and accrued amount,
 * and the account's balance against the token's supply.
 */
export interface EmissionSide {
  /** Reserve token id: `index × 2` for the dToken, `+ 1` for the bToken. */
  id: number;
  /** Emission rate, BLND per second scaled by `10^epsDecimals` (7 on V1, 14 on V2). */
  eps: bigint;
  epsDecimals: number;
  /** When the schedule ends, seconds since the epoch. */
  expiration: number;
  /** The token's current emission index, and the account's last checkpointed one (null: none yet). */
  index: bigint;
  userIndex: bigint | null;
  /** BLND accrued to the account at its last checkpoint, in the reserve token's decimals. */
  accrued: bigint;
  /** The account's balance of the token and the token's total supply, in its own decimals. */
  balance: bigint;
  supply: bigint;
  decimals: number;
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Blend emissions: bad ${label}`);
}

/**
 * Claimable BLND per reserve token and the position's accrual rate, from the sides that emit.
 * The accrual is the SDK's own arithmetic (`UserEmissions.estimateAccrual`) kept in integers:
 * `balance × (index − userIndex) / 10^epsDecimals + accrued`, in the reserve token's decimals as
 * the SDK reads it, rescaled to BLND's. An account with a balance but no emission data yet
 * accrues from index 0, as the pool itself does when emissions began after the position.
 */
export function emissionsFromSides(sides: EmissionSide[], now: number): BlendEmissionsView {
  const claimable = new Map<number, bigint>();
  let rateScaled = 0n;
  for (const side of sides) {
    assertCount(side.epsDecimals, "epsDecimals");
    assertCount(side.decimals, "decimals");
    if (side.balance < 0n || side.supply < 0n || side.accrued < 0n || side.eps < 0n) {
      throw new Error("Blend emissions: negative amount");
    }
    if (side.userIndex === null && side.balance === 0n) continue;
    const userIndex = side.userIndex ?? 0n;
    if (side.index < userIndex) throw new Error("Blend emissions: index moved backwards");
    const epsScale = 10n ** BigInt(side.epsDecimals);
    const accrual = (side.balance * (side.index - userIndex)) / epsScale + side.accrued;
    const amount = (accrual * BLND_SCALE) / 10n ** BigInt(side.decimals);
    if (amount > 0n) claimable.set(side.id, amount);
    if (side.expiration > now && side.supply > 0n && side.balance > 0n) {
      rateScaled +=
        (side.eps * side.balance * BLND_SCALE * REWARD_RATE_SCALE) / (epsScale * side.supply);
    }
  }
  return { claimable, rateScaled };
}

/** The backstop's per-(pool, user) state as the SDK reads it, reduced to what the plan needs. */
export interface BackstopReadout {
  backstopId: string;
  config: { backstopTkn: string; blndTkn: string };
  balance: {
    shares: bigint;
    /** Withdrawals still locked: the SDK already moved the unlocked ones into `unlockedQ4W`. */
    q4w: Array<{ amount: bigint; exp: bigint | number }>;
    unlockedQ4W: bigint;
  };
  /** The account's emission checkpoint for this pool's backstop, if it ever had one. */
  userEmissions: { index: bigint; accrued: bigint } | undefined;
  /** The backstop pool's emission index, if the pool is in the reward zone. */
  poolEmissions: { index: bigint; epsDecimals: number } | undefined;
}

export function backstopViewFrom(readout: BackstopReadout): BlendBackstopView {
  const { balance } = readout;
  let emissions = 0n;
  if (readout.poolEmissions && (readout.userEmissions || balance.shares > 0n)) {
    // Backstop emissions accrue to unqueued shares only, as the SDK estimates them.
    const { index, epsDecimals } = readout.poolEmissions;
    assertCount(epsDecimals, "epsDecimals");
    const user = readout.userEmissions ?? { index: 0n, accrued: 0n };
    if (index < user.index) throw new Error("Blend emissions: index moved backwards");
    emissions = (balance.shares * (index - user.index)) / 10n ** BigInt(epsDecimals) + user.accrued;
  }
  return {
    contract: readout.backstopId,
    backstopToken: readout.config.backstopTkn,
    blndToken: readout.config.blndTkn,
    shares: balance.shares,
    queued: balance.q4w.map((q) => ({ amount: q.amount, unlocksAt: Number(q.exp) })),
    unlocked: balance.unlockedQ4W,
    emissions,
  };
}

export const defaultBlendDeps: BlendDeps = {
  loadPool(network, poolId, version) {
    const sdkNetwork = blendSdkNetwork(network);
    return version === Version.V1
      ? PoolV1.load(sdkNetwork, poolId)
      : PoolV2.load(sdkNetwork, poolId);
  },
  estimate(pool, oracle, positions) {
    // The real pool is a real SDK Pool; the view type only narrows what the adapter touches.
    return PositionsEstimate.build(pool as Pool, oracle, positions);
  },
  emissions(pool, user, now) {
    const real = pool as Pool;
    const poolUser = user as PoolUser;
    const sides: EmissionSide[] = [];
    for (const reserve of real.reserves.values()) {
      const tokens = [
        {
          id: reserve.getDTokenEmissionIndex(),
          emissions: reserve.borrowEmissions,
          balance: poolUser.getLiabilityDTokens(reserve),
          supply: reserve.data.dSupply,
        },
        {
          id: reserve.getBTokenEmissionIndex(),
          emissions: reserve.supplyEmissions,
          balance: poolUser.getSupplyBTokens(reserve) + poolUser.getCollateralBTokens(reserve),
          supply: reserve.data.bSupply,
        },
      ];
      for (const token of tokens) {
        if (!token.emissions) continue;
        const data = poolUser.emissions.get(token.id);
        sides.push({
          id: token.id,
          eps: token.emissions.eps,
          epsDecimals: token.emissions.epsDecimals,
          expiration: token.emissions.expiration,
          index: token.emissions.index,
          userIndex: data?.index ?? null,
          accrued: data?.accrued ?? 0n,
          balance: token.balance,
          supply: token.supply,
          decimals: reserve.config.decimals,
        });
      }
    }
    return emissionsFromSides(sides, now);
  },
  async loadBackstop(network, version, backstopId, poolId, account, now) {
    const sdkNetwork = blendSdkNetwork(network);
    const [config, user, backstopPool] = await Promise.all([
      BackstopConfig.load(sdkNetwork, backstopId),
      BackstopPoolUser.load(sdkNetwork, backstopId, poolId, account, now),
      version === Version.V1
        ? BackstopPoolV1.load(sdkNetwork, backstopId, poolId, now)
        : BackstopPoolV2.load(sdkNetwork, backstopId, poolId, now),
    ]);
    return backstopViewFrom({
      backstopId,
      config,
      balance: user.balance,
      userEmissions: user.emissions,
      poolEmissions: backstopPool.emissions,
    });
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
      pool: string;
      positions: BlendReservePosition[];
      emissions: BlendEmissionsView & { total: bigint };
      backstop: BlendBackstopView;
      /** Kept so `health` can estimate the state a plan leaves, not just the state read. */
      poolView: BlendPoolView;
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

/** Whole days, rounded up, for a message; never "0 days" while any time is left. */
function daysLeft(seconds: number): string {
  const days = Math.max(1, Math.ceil(seconds / 86_400));
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function blendExitAdapter(
  deps: BlendDeps = defaultBlendDeps
): ExitAdapter<BlendPosition, BlendLive> {
  return {
    protocol: "blend",

    supports(position: DefiPosition): position is BlendPosition {
      if (position.protocol !== "blend") return false;
      // A backstop deposit is read from the pool's backstop alongside the pool position itself.
      return position.positionType === "supply" || position.positionType === "borrow";
    },

    async readLive(position, code, ctx): Promise<BlendLive> {
      if (code.kind !== "pool") return { status: "not_pool", kind: code.kind };
      const version = blendSdkVersion(code.version);
      if (version === null) return { status: "unsupported_version", version: code.version };

      try {
        const now = Math.floor(ctx.now.getTime() / 1000);
        const pool = await deps.loadPool(ctx.network, position.contractAddress, version);
        const [oracle, user, backstop] = await Promise.all([
          pool.loadOracle(),
          pool.loadUser(ctx.account),
          deps.loadBackstop(
            ctx.network,
            version,
            pool.metadata.backstop,
            position.contractAddress,
            ctx.account,
            now
          ),
        ]);
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

        const emissions = deps.emissions(pool, user, now);
        let total = 0n;
        for (const amount of emissions.claimable.values()) total += amount;

        return {
          status: "loaded",
          version: pool.version,
          pool: position.contractAddress,
          positions: held,
          emissions: { ...emissions, total },
          backstop,
          poolView: pool,
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
            "backstop, or registry entry may be wrong. No exit was built; this position needs " +
            "manual review."
        );
      }

      const steps: ExitStep[] = [];
      const blockers: ExitPlan["blockers"] = [];
      // What the account can receive and carry on through the close: XLM and the classic assets
      // it holds an authorized trustline for, under their Stellar Asset Contracts. BLND is one on
      // every network Blend runs on; the backstop's LP share is a Soroban token the close cannot
      // convert yet (#161), so paying it out to the account would only move the loss to the merge.
      const canCarry = (token: string): boolean => token in ctx.tokenBalances;

      // Emissions first: once the account is merged nobody can come back for them. What accrued
      // during the close itself is left with the pool rather than chased round after round.
      if (rewardIsWorthClaiming(live.emissions.total, live.emissions.rateScaled)) {
        const blnd = live.emissions.total;
        if (!canCarry(live.backstop.blndToken)) {
          blockers.push({
            code: "blend_emissions_trustline_missing",
            message:
              `This account has ${blnd} base units of BLND emissions accrued in Blend pool ${pool} ` +
              "but no authorized BLND trustline to receive them. Add the trustline first, or claim " +
              "through Blend before continuing.",
          });
        } else {
          steps.push({
            kind: "claim",
            contract: position.contractAddress,
            function: "claim",
            asset: live.backstop.blndToken,
            amount: blnd.toString(),
            ceiling: blnd.toString(),
            minReceived: [],
            description: `Claim ${blnd} base units of BLND emissions from Blend pool ${pool}`,
          });
        }
      }

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

      // The backstop deposit. Blend pays a queued withdrawal out only after its cooldown, so the
      // one thing this close can do is take out what has already unlocked; everything else is a
      // wait the tool cannot shorten, and a merge in the meantime would forfeit the deposit.
      const { backstop } = live;
      const now = Math.floor(ctx.now.getTime() / 1000);
      const cooldown = BACKSTOP_COOLDOWN_SECONDS[live.version];
      if (backstop.shares > 0n) {
        blockers.push({
          code: "backstop_withdrawal_not_queued",
          message:
            `This account has ${backstop.shares} backstop shares deposited for Blend pool ${pool} ` +
            "that are not queued for withdrawal. Blend's backstop pays out only after a " +
            `${daysLeft(cooldown)} queue: queue the withdrawal through Blend, then come back once ` +
            "it unlocks. Closing now would forfeit the deposit.",
        });
      }
      // Every queued entry still listed is locked: the read already moved the unlocked ones out.
      if (backstop.queued.length > 0) {
        const amount = backstop.queued.reduce((sum, q) => sum + q.amount, 0n);
        const remaining = Math.max(...backstop.queued.map((q) => q.unlocksAt)) - now;
        blockers.push({
          code: "backstop_withdrawal_cooling_down",
          message:
            `This account has ${amount} backstop shares queued for withdrawal from Blend pool ` +
            `${pool}, still cooling down: the last of them unlocks in ${daysLeft(remaining)}. ` +
            "Closing now would forfeit them; come back once the queue clears.",
        });
      }
      if (backstop.unlocked > 0n) {
        if (canCarry(backstop.backstopToken)) {
          steps.push({
            kind: "withdraw",
            contract: backstop.contract,
            function: "withdraw",
            asset: backstop.backstopToken,
            amount: backstop.unlocked.toString(),
            ceiling: backstop.unlocked.toString(),
            minReceived: [],
            description: `Withdraw ${backstop.unlocked} unlocked backstop shares queued for Blend pool ${pool}`,
          });
        } else {
          blockers.push({
            code: "backstop_token_unconvertible",
            message:
              `This account has ${backstop.unlocked} backstop shares for Blend pool ${pool} ready to ` +
              "withdraw, but they pay out in the backstop's LP token, which LumenWipe cannot yet " +
              "convert or carry to the destination. Withdraw them through Blend and redeem the LP " +
              "token before continuing; closing now would forfeit them.",
          });
        }
      }
      if (backstop.emissions > 0n) {
        blockers.push({
          code: "backstop_emissions_unclaimed",
          message:
            `This account has ${backstop.emissions} base units of BLND emissions accrued to its ` +
            `backstop deposit for Blend pool ${pool}. LumenWipe does not claim backstop emissions ` +
            "(Blend re-deposits them as backstop shares); claim them through Blend before " +
            "continuing, or closing now would forfeit them.",
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
          EXIT_POSITION_GONE,
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
        live.poolView,
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

      if (step.kind === "claim") {
        const ids = [...live.emissions.claimable.keys()].sort((a, b) => a - b);
        const client =
          live.version === Version.V1
            ? new PoolContractV1(step.contract)
            : new PoolContractV2(step.contract);
        const opXdr = client.claim({ from: ctx.account, reserve_token_ids: ids, to: ctx.account });
        return {
          step,
          build: { source: "local", op: xdr.Operation.fromXDR(opXdr, "base64") },
          intent: {
            contract: step.contract,
            function: "claim",
            args: [ctx.account, ...ids.map(String), ctx.account],
            minReceived: [],
            recipient: ctx.account,
          },
        };
      }

      if (step.contract === live.backstop.contract && step.contract !== live.pool) {
        if (step.kind !== "withdraw") {
          throw new Error(`Blend: no backstop call for a ${step.kind} step`);
        }
        const client =
          live.version === Version.V1
            ? new BackstopContractV1(step.contract)
            : new BackstopContractV2(step.contract);
        const opXdr = client.withdraw({
          from: ctx.account,
          pool_address: live.pool,
          amount: BigInt(step.amount),
        });
        return {
          step,
          build: { source: "local", op: xdr.Operation.fromXDR(opXdr, "base64") },
          intent: {
            contract: step.contract,
            function: "withdraw",
            args: [ctx.account, live.pool, step.amount],
            minReceived: [],
            recipient: ctx.account,
          },
        };
      }

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
