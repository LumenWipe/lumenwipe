import { Address, Asset, Contract, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type {
  DefiPosition,
  PhoenixLpPosition,
  PhoenixStakePosition,
  PlanBlocker,
} from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  EXIT_POSITION_GONE,
  type BuiltExitStep,
  type ExitAdapter,
  type ExitPlan,
  type ExitRpc,
  type ExitStep,
} from "./adapter";
import { minReceivedFromQuote } from "./invariants";

/**
 * The Phoenix exit (architecture.md §9.6): an LP position leaves the pool through
 * `withdraw_liquidity(sender, share_amount, min_a, min_b, deadline, auto_unstake)`, which burns
 * the account's shares (held in the pool's own `share_token` SEP-41 balance) and pays both
 * reserves back to the account pro rata, bounded by one floor per token. A staked position must
 * unbond first: staking lives in a separate contract (`config.stake_contract`, itself read from
 * the pool's own storage) whose `unbond(sender, stake_amount, stake_timestamp)` requires an exact
 * match against one of the account's individual stakes and returns the shares to the account's
 * plain balance, ready for `withdraw_liquidity` on a later round. `auto_unstake` (a single
 * combined call) is never used: unbonding every stake as its own step is uniform regardless of
 * how many stakes exist, and the close loop already re-plans fresh state every round.
 *
 * Unlike Aquarius and Soroswap, every value here lives in the pool's and stake contract's
 * PERSISTENT storage, not instance storage: `CONFIG` (a symbol key) for the pool's addresses,
 * `DataKey::TotalShares/ReserveA/ReserveB` (bare `u32` keys, 0/1/2) for its reserves, and the
 * stake contract's per-account entry keyed directly by the bare account address (no wrapping) for
 * `BondingInfo`. Everything is read directly off the ledger; nothing here needs a simulation.
 *
 * Phoenix's optional reward-distribution flows (`distribute_rewards`/`withdraw_rewards`) are not
 * part of this adapter: architecture.md §9.6 and issue #281 describe only `withdraw_liquidity`
 * and `unbond`, unlike Aquarius/Blend where a reward claim is explicit. Adding one here would be
 * unscoped guesswork about a flow most pools never configure.
 */

export interface PhoenixStakeEntry {
  amount: bigint;
  /** Unix seconds; the exact value `unbond` must be given back to match the ledger's entry. */
  timestamp: bigint;
}

export interface PhoenixPoolState {
  pool: string;
  tokenA: string;
  tokenB: string;
  shareToken: string;
  stakeContract: string;
  reserveA: bigint;
  reserveB: bigint;
  totalShares: bigint;
  /** The account's unstaked LP shares; base units, same decimals as `shareToken`. */
  shares: bigint;
  /** The account's individual stakes, sorted oldest-first for a deterministic unbond order. */
  stakes: PhoenixStakeEntry[];
  /** Which of tokenA/tokenB are Stellar Asset Contracts: receiving one needs a trustline. */
  stellarAssetTokens: Set<string>;
}

export type PhoenixLive =
  | ({ status: "loaded" } & PhoenixPoolState)
  | { status: "not_pool"; kind: string }
  /** The pool reads fine but the account's share entry is not on the ledger at all - only
   *  reported when an LP position was detected here, so a real balance is expected. */
  | { status: "shares_unreadable" }
  /** The stake contract reads fine but the account's bonding entry is not on the ledger at all -
   *  only reported when a stake position was detected here, so real stakes are expected. */
  | { status: "stakes_unreadable" }
  | { status: "unreadable" };

export type PhoenixPosition = PhoenixLpPosition | PhoenixStakePosition;

interface InstanceView {
  isStellarAsset: boolean;
}

function instanceView(val: xdr.LedgerEntryData): InstanceView {
  const instance = val.contractData().val().instance();
  return {
    isStellarAsset:
      instance.executable().switch() ===
      xdr.ContractExecutableType.contractExecutableStellarAsset(),
  };
}

function mapView(val: xdr.ScVal): Map<string, xdr.ScVal> {
  const out = new Map<string, xdr.ScVal>();
  if (val.switch() !== xdr.ScValType.scvMap()) return out;
  for (const entry of val.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol()) out.set(key.sym().toString(), entry.val());
  }
  return out;
}

const asAddress = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvAddress()
    ? Address.fromScAddress(val.address()).toString()
    : null;

const asUnsigned = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  if (typeof native === "bigint") return native >= 0n ? native : null;
  if (typeof native === "number" && Number.isInteger(native) && native >= 0) return BigInt(native);
  return null;
};

/** A persistent `contractData` ledger key for an arbitrary (already-encoded) storage key. */
const persistentKey = (contract: string, key: xdr.ScVal): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

const configKey = (pool: string): xdr.LedgerKey =>
  persistentKey(pool, xdr.ScVal.scvSymbol("CONFIG"));
const totalSharesKey = (pool: string): xdr.LedgerKey => persistentKey(pool, xdr.ScVal.scvU32(0));
const reserveAKey = (pool: string): xdr.LedgerKey => persistentKey(pool, xdr.ScVal.scvU32(1));
const reserveBKey = (pool: string): xdr.LedgerKey => persistentKey(pool, xdr.ScVal.scvU32(2));

const balanceKey = (token: string, account: string): xdr.LedgerKey =>
  persistentKey(
    token,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(account).toScVal()])
  );

/** The stake contract's per-account bonding entry: keyed by the bare account address, no wrapping. */
const bondingInfoKey = (stakeContract: string, account: string): xdr.LedgerKey =>
  persistentKey(stakeContract, new Address(account).toScVal());

async function readEntries(
  rpc: ExitRpc,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const res = await rpc.getLedgerEntries(...keys);
  const out = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) out.set(entry.key.toXDR("base64"), entry.val);
  return out;
}

/** The individual stakes a `BondingInfo` entry holds, oldest first. Null on a malformed shape. */
function stakesFrom(val: xdr.ScVal): PhoenixStakeEntry[] | null {
  const fields = mapView(val);
  const stakesVal = fields.get("stakes");
  if (!stakesVal || stakesVal.switch() !== xdr.ScValType.scvVec()) return null;
  const stakes: PhoenixStakeEntry[] = [];
  for (const item of stakesVal.vec() ?? []) {
    const stakeFields = mapView(item);
    const amount = asUnsigned(stakeFields.get("stake"));
    const timestamp = asUnsigned(stakeFields.get("stake_timestamp"));
    if (amount === null || timestamp === null) return null;
    stakes.push({ amount, timestamp });
  }
  return stakes.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function manualReview(code: string, message: string): ExitPlan {
  return { steps: [], blockers: [{ code, message }] };
}

export function phoenixExitAdapter(): ExitAdapter<PhoenixPosition, PhoenixLive> {
  return {
    protocol: "phoenix",

    supports(position: DefiPosition): position is PhoenixPosition {
      if (position.protocol !== "phoenix") return false;
      return position.positionType === "lp" || position.positionType === "stake";
    },

    async readLive(position, code, ctx, rpc): Promise<PhoenixLive> {
      if (code.kind !== "pool") return { status: "not_pool", kind: code.kind };

      try {
        const pool = position.contractAddress;
        const cfgKey = configKey(pool);
        const sharesKey = totalSharesKey(pool);
        const first = await readEntries(rpc, [cfgKey, sharesKey]);
        const configVal = first.get(cfgKey.toXDR("base64"));
        const totalSharesVal = first.get(sharesKey.toXDR("base64"));
        if (!configVal || !totalSharesVal) return { status: "unreadable" };

        const config = mapView(configVal.contractData().val());
        const tokenA = asAddress(config.get("token_a"));
        const tokenB = asAddress(config.get("token_b"));
        const shareToken = asAddress(config.get("share_token"));
        const stakeContract = asAddress(config.get("stake_contract"));
        const totalShares = asUnsigned(totalSharesVal.contractData().val());
        if (!tokenA || !tokenB || !shareToken || !stakeContract || totalShares === null) {
          return { status: "unreadable" };
        }

        const reserveAK = reserveAKey(pool);
        const reserveBK = reserveBKey(pool);
        const shareBalanceKey = balanceKey(shareToken, ctx.account);
        const bondingKey = bondingInfoKey(stakeContract, ctx.account);
        const tokenAKey = new Contract(tokenA).getFootprint();
        const tokenBKey = new Contract(tokenB).getFootprint();
        const second = await readEntries(rpc, [
          reserveAK,
          reserveBK,
          shareBalanceKey,
          bondingKey,
          tokenAKey,
          tokenBKey,
        ]);
        const reserveA = asUnsigned(second.get(reserveAK.toXDR("base64"))?.contractData().val());
        const reserveB = asUnsigned(second.get(reserveBK.toXDR("base64"))?.contractData().val());
        if (reserveA === null || reserveB === null) return { status: "unreadable" };

        // The share token writes a zero balance on a full withdrawal and keeps the entry (SEP-41
        // convention); a present-but-empty stake entry behaves the same way. So an absent entry is
        // ambiguous between "never held" and "archived while still holding" - safe to treat as
        // empty only when detection did not claim this specific sub-resource exists here.
        const shareEntry = second.get(shareBalanceKey.toXDR("base64"));
        if (!shareEntry && position.positionType === "lp") return { status: "shares_unreadable" };
        const shares = shareEntry ? asUnsigned(shareEntry.contractData().val()) : 0n;
        if (shares === null) return { status: "unreadable" };

        const bondingEntry = second.get(bondingKey.toXDR("base64"));
        if (!bondingEntry && position.positionType === "stake") {
          return { status: "stakes_unreadable" };
        }
        const stakes = bondingEntry ? stakesFrom(bondingEntry.contractData().val()) : [];
        if (stakes === null) return { status: "unreadable" };

        const stellarAssetTokens = new Set<string>();
        for (const [token, key] of [
          [tokenA, tokenAKey],
          [tokenB, tokenBKey],
        ] as const) {
          const val = second.get(key.toXDR("base64"));
          if (!val) return { status: "unreadable" };
          if (instanceView(val).isStellarAsset) stellarAssetTokens.add(token);
        }

        return {
          status: "loaded",
          pool,
          tokenA,
          tokenB,
          shareToken,
          stakeContract,
          reserveA,
          reserveB,
          totalShares,
          shares,
          stakes,
          stellarAssetTokens,
        };
      } catch {
        return { status: "unreadable" };
      }
    },

    plan(position, live, _code, ctx): ExitPlan {
      const pool = shortAddress(position.contractAddress);
      if (live.status === "not_pool") {
        return manualReview(
          "phoenix_contract_not_pool",
          `The Phoenix contract ${pool} holding this position is registered as a ${live.kind}, not ` +
            "a liquidity pool. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "shares_unreadable") {
        return manualReview(
          "phoenix_shares_unreadable",
          `This account's share balance in Phoenix pool ${pool} is not on the ledger right now - ` +
            "most likely archived after a long idle period. No exit was built so the shares are not " +
            "left behind; restore the entry or withdraw through Phoenix before continuing."
        );
      }
      if (live.status === "stakes_unreadable") {
        return manualReview(
          "phoenix_stakes_unreadable",
          `This account's staked position in Phoenix pool ${pool} is not on the ledger right now - ` +
            "most likely archived after a long idle period. No exit was built so the stake is not " +
            "left behind; restore the entry or unbond through Phoenix before continuing."
        );
      }
      if (live.status === "unreadable") {
        return manualReview(
          "phoenix_pool_unreadable",
          `The Phoenix pool ${pool} could not be read as a liquidity pool right now, so no exit was ` +
            "built. Retry the analysis; if it keeps failing this position needs manual review."
        );
      }
      if (live.shares === 0n && live.stakes.length === 0) {
        return manualReview(
          EXIT_POSITION_GONE,
          `This account no longer holds shares or stakes in Phoenix pool ${pool}; the position was ` +
            "already withdrawn."
        );
      }
      if (live.shares > live.totalShares) {
        return manualReview(
          "phoenix_pool_unreadable",
          `The Phoenix pool ${pool} reports fewer shares in total than this account holds, so the ` +
            "position cannot be valued. No exit was built; this position needs manual review."
        );
      }

      // Every stake unbonds before anything is withdrawn: only once the account holds its shares
      // plainly can `withdraw_liquidity` see the full balance. One step per stake, oldest first,
      // matching what the ledger actually holds - never a projection of a future balance.
      if (live.stakes.length > 0) {
        const steps: ExitStep[] = live.stakes.map((stake) => ({
          kind: "unstake",
          contract: live.stakeContract,
          function: "unbond",
          asset: live.shareToken,
          amount: stake.amount.toString(),
          ceiling: stake.amount.toString(),
          minReceived: [],
          description:
            `Unbond ${stake.amount} LP shares staked in Phoenix pool ${pool} ` +
            `(staked at unix time ${stake.timestamp})`,
        }));
        return { steps, blockers: [] };
      }

      const native = Asset.native().contractId(NETWORK_PASSPHRASES[ctx.network]);
      const needsTrustline = (token: string): boolean =>
        token !== native && live.stellarAssetTokens.has(token) && !(token in ctx.tokenBalances);
      const blockers: PlanBlocker[] = [];
      for (const token of [live.tokenA, live.tokenB]) {
        if (!needsTrustline(token)) continue;
        blockers.push({
          code: "phoenix_trustline_missing",
          message:
            `Withdrawing from Phoenix pool ${pool} pays out an asset (token contract ` +
            `${shortAddress(token)}) this account has no authorized trustline for, so the ` +
            "withdrawal would fail at the ledger. Add or re-authorize the trustline first, or " +
            "withdraw through Phoenix before continuing.",
        });
      }
      if (blockers.length > 0) return { steps: [], blockers };

      const minA = minReceivedFromQuote(
        ((live.shares * live.reserveA) / live.totalShares).toString(),
        ctx.slippageBps
      );
      const minB = minReceivedFromQuote(
        ((live.shares * live.reserveB) / live.totalShares).toString(),
        ctx.slippageBps
      );
      if (minA === "0" || minB === "0") {
        return manualReview(
          "phoenix_position_too_small",
          `This account's shares of Phoenix pool ${pool} are worth less than one base unit of one ` +
            "of its tokens after the slippage margin, so no meaningful minimum can be set. Withdraw " +
            "the liquidity through Phoenix before continuing."
        );
      }

      const step: ExitStep = {
        kind: "lp_withdraw",
        contract: live.pool,
        function: "withdraw_liquidity",
        asset: live.pool,
        amount: live.shares.toString(),
        ceiling: live.shares.toString(),
        minReceived: [
          { asset: live.tokenA, amount: minA },
          { asset: live.tokenB, amount: minB },
        ],
        description:
          `Withdraw all liquidity from Phoenix pool ${pool}: ${live.shares} LP tokens for at least ` +
          `${minA} of ${shortAddress(live.tokenA)} and ${minB} of ${shortAddress(live.tokenB)}`,
      };
      return { steps: [step], blockers: [] };
    },

    health(): null {
      // An LP or stake position carries no debt; there is no health to keep.
      return null;
    },

    buildStep(step, live, ctx): BuiltExitStep {
      if (live.status !== "loaded") throw new Error("Phoenix: cannot build against an unread pool");
      const account = new Address(ctx.account).toScVal();
      const i128 = (v: string | bigint): xdr.ScVal => nativeToScVal(BigInt(v), { type: "i128" });

      if (step.kind === "unstake") {
        // `plan()` emits one step per `live.stakes` entry, oldest first, and only ever builds
        // `steps[0]` - so the step being built here is always `live.stakes[0]`, never a lookup by
        // amount (which two distinct stakes could share).
        const stake = live.stakes[0];
        if (!stake) throw new Error("Phoenix: no stake to unbond");
        const timestamp = nativeToScVal(stake.timestamp, { type: "u64" });
        return {
          step,
          build: {
            source: "local",
            op: new Contract(step.contract).call("unbond", account, i128(stake.amount), timestamp),
          },
          intent: {
            contract: step.contract,
            function: "unbond",
            args: [ctx.account, stake.amount.toString(), stake.timestamp.toString()],
            minReceived: [],
            recipient: ctx.account,
          },
        };
      }

      if (step.kind !== "lp_withdraw") throw new Error(`Phoenix: no call for a ${step.kind} step`);
      const [floorA, floorB] = step.minReceived;
      if (!floorA || !floorB) throw new Error("Phoenix: a withdrawal needs both floors");
      const none = xdr.ScVal.scvVoid();
      return {
        step,
        build: {
          source: "local",
          op: new Contract(step.contract).call(
            "withdraw_liquidity",
            account,
            i128(step.amount),
            i128(floorA.amount),
            i128(floorB.amount),
            none,
            none
          ),
        },
        intent: {
          contract: step.contract,
          function: "withdraw_liquidity",
          args: [ctx.account, step.amount, floorA.amount, floorB.amount],
          minReceived: step.minReceived,
          recipient: ctx.account,
        },
      };
    },
  };
}
