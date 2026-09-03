import {
  Account,
  Address,
  Asset,
  Contract,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc as stellarRpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type {
  AquariusLpPosition,
  AquariusPoolType,
  DefiPosition,
  PlanBlocker,
} from "@lumenwipe/types";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
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
 * Aquarius exit (architecture.md §9.4): an LP position leaves through the pool's own
 * `withdraw(user, share_amount, min_amounts)`, which burns the account's shares (held in the
 * pool's separate share-token contract) and pays every reserve back to the account, pro rata and
 * bounded by one floor per token. AQUA rewards accrued to the position are claimed first through
 * `claim(user)`, since a merged account could never come back for them.
 *
 * Everything the plan needs is read from the ledger: the pool's instance holds its tokens,
 * reserves, total shares, share token, reward token, and the admin's claim switch; the account's
 * shares are the share token's SEP-41 `Balance(account)`. The one value the ledger does not hold
 * ready-made is the accrued reward, so it is read through a simulated `get_user_reward(user)` -
 * a read-only call, never signed.
 *
 * Constant-product and stableswap pools are share-based and exit here. Concentrated-liquidity
 * pools keep positions as tick ranges without shares and are refused by name.
 */

export interface AquariusPoolState {
  pool: string;
  poolType: Exclude<AquariusPoolType, "concentrated">;
  /** The pool's tokens in the pool's own order: the order `withdraw` pays out and `min_amounts` is given in. */
  tokens: string[];
  reserves: bigint[];
  totalShares: bigint;
  shareToken: string;
  /** The account's LP tokens, base units (7 decimals). */
  shares: bigint;
  rewardToken: string;
  /** Accrued, unclaimed AQUA in base units. */
  reward: bigint;
  /** The pool admin has paused claiming (`kill_claim`). */
  claimKilled: boolean;
  /** Tokens that are Stellar Asset Contracts: receiving one needs a trustline for its asset. */
  stellarAssetTokens: Set<string>;
}

export type AquariusLive =
  | ({ status: "loaded" } & AquariusPoolState)
  | { status: "not_pool"; kind: string }
  | { status: "unsupported_pool_type"; version: string }
  /** The pool reads fine but the account's share entry is not on the ledger at all. */
  | { status: "shares_unreadable" }
  /** The pool reads fine but the accrued reward could not be read. */
  | { status: "reward_unreadable" }
  | { status: "unreadable" };

const K = {
  tokens: '["Tokens"]',
  tokenA: '["TokenA"]',
  tokenB: '["TokenB"]',
  reserves: '["Reserves"]',
  reserveA: '["ReserveA"]',
  reserveB: '["ReserveB"]',
  totalShares: '["TotalShares"]',
  tokenShare: '["TokenShare"]',
  rewardToken: '["RewardToken"]',
  isKilledClaim: '["IsKilledClaim"]',
} as const;

interface InstanceView {
  isStellarAsset: boolean;
  storage: Map<string, xdr.ScVal>;
}

function instanceView(val: xdr.LedgerEntryData): InstanceView {
  const instance = val.contractData().val().instance();
  const isStellarAsset =
    instance.executable().switch() === xdr.ContractExecutableType.contractExecutableStellarAsset();
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage() ?? []) {
    let name: unknown;
    try {
      name = JSON.stringify(scValToNative(entry.key()));
    } catch {
      continue;
    }
    if (typeof name === "string") storage.set(name, entry.val());
  }
  return { isStellarAsset, storage };
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

function asAddressList(val: xdr.ScVal | undefined): string[] | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: string[] = [];
  for (const item of val.vec() ?? []) {
    const address = asAddress(item);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

function asUnsignedList(val: xdr.ScVal | undefined): bigint[] | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: bigint[] = [];
  for (const item of val.vec() ?? []) {
    const n = asUnsigned(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

async function readEntries(
  rpc: ExitRpc,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const res = await rpc.getLedgerEntries(...keys);
  const out = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) out.set(entry.key.toXDR("base64"), entry.val);
  return out;
}

const balanceKey = (token: string, account: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(token).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(account).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

/**
 * A read-only contract call, evaluated by simulation and never signed. Returns null when the
 * network refuses or the value is not what was expected; the caller decides what that means.
 */
async function simulateUnsigned(
  rpc: ExitRpc,
  network: keyof typeof NETWORK_PASSPHRASES,
  account: string,
  sequence: string,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<bigint | null> {
  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const response = await rpc.simulateTransaction(tx);
  const simulation = stellarRpc.Api.isSimulationRaw(response)
    ? stellarRpc.parseRawSimulation(response)
    : response;
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) return null;
  return asUnsigned(simulation.result?.retval);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function manualReview(code: string, message: string): ExitPlan {
  const blocker: PlanBlocker = { code, message };
  return { steps: [], blockers: [blocker] };
}

/**
 * Per-account reward-tracking keys Aquarius pools and their reward gauges keep. `withdraw` and
 * `claim` checkpoint the account's rewards, which WRITES these - but only once the reward period
 * has moved on since the account's last interaction. A simulation run inside the same period reads
 * them and never writes, so it records them read-only, and the execution a few ledgers later
 * traps on "key outside of the footprint" (observed live on testnet). Promoting them to read-write
 * costs a little declared write capacity and makes the transaction valid either way.
 */
const ACCOUNT_REWARD_KEYS = new Set([
  "UserRewardData",
  "UserRewardsState",
  "UserRewardState",
  "WorkingBalance",
]);
/** Declared write capacity and fee added per promoted key; generous, and refunded where unused. */
const PROMOTED_KEY_WRITE_BYTES = 512;
const PROMOTED_KEY_FEE_STROOPS = 50_000n;

function isAccountRewardKey(key: xdr.LedgerKey, account: string): boolean {
  if (key.switch() !== xdr.LedgerEntryType.contractData()) return false;
  const val = key.contractData().key();
  if (val.switch() !== xdr.ScValType.scvVec()) return false;
  const parts = val.vec() ?? [];
  if (parts.length !== 2) return false;
  const [name, who] = parts;
  return (
    name!.switch() === xdr.ScValType.scvSymbol() &&
    ACCOUNT_REWARD_KEYS.has(name!.sym().toString()) &&
    asAddress(who) === account
  );
}

/** The assembled transaction with the account's reward keys in the read-write footprint. */
export function promoteRewardKeys(tx: Transaction, account: string): Transaction {
  const ext = tx.toEnvelope().v1().tx().ext();
  if (ext.switch() !== 1) return tx;
  const data = ext.sorobanData();
  const footprint = data.resources().footprint();
  const promoted = footprint.readOnly().filter((k) => isAccountRewardKey(k, account));
  if (promoted.length === 0) return tx;
  const promotedXdr = new Set(promoted.map((k) => k.toXDR("base64")));
  const readOnly = footprint.readOnly().filter((k) => !promotedXdr.has(k.toXDR("base64")));
  const readWrite = [...footprint.readWrite(), ...promoted];
  const resources = data.resources();
  const resourceFee = data.resourceFee().toBigInt();
  const extraFee = PROMOTED_KEY_FEE_STROOPS * BigInt(promoted.length);
  const sorobanData = new SorobanDataBuilder(data)
    .setFootprint(readOnly, readWrite)
    .setResources(
      resources.instructions(),
      resources.diskReadBytes(),
      resources.writeBytes() + PROMOTED_KEY_WRITE_BYTES * promoted.length
    )
    .setResourceFee(resourceFee + extraFee)
    .build();
  // The builder adds the resource fee back on build, so hand it the inclusion fee alone.
  const inclusionFee = BigInt(tx.fee) - resourceFee;
  return TransactionBuilder.cloneFrom(tx, { fee: inclusionFee.toString(), sorobanData }).build();
}

function poolTypeOf(version: string): Exclude<AquariusPoolType, "concentrated"> | null {
  if (version === "constant_product" || version === "stable") return version;
  return null;
}

export function aquariusExitAdapter(): ExitAdapter<AquariusLpPosition, AquariusLive> {
  return {
    protocol: "aquarius",

    supports(position: DefiPosition): position is AquariusLpPosition {
      return position.protocol === "aquarius" && position.positionType === "lp";
    },

    async readLive(position, code, ctx, rpc): Promise<AquariusLive> {
      if (code.kind !== "pool") return { status: "not_pool", kind: code.kind };
      const poolType = poolTypeOf(code.version);
      if (poolType === null) return { status: "unsupported_pool_type", version: code.version };

      try {
        const pool = position.contractAddress;
        const poolKey = new Contract(pool).getFootprint();
        const first = await readEntries(rpc, [poolKey]);
        const poolVal = first.get(poolKey.toXDR("base64"));
        if (!poolVal) return { status: "unreadable" };
        const { storage } = instanceView(poolVal);

        const tokens = storage.has(K.tokens)
          ? asAddressList(storage.get(K.tokens))
          : (() => {
              const a = asAddress(storage.get(K.tokenA));
              const b = asAddress(storage.get(K.tokenB));
              return a && b ? [a, b] : null;
            })();
        const reserves = storage.has(K.reserves)
          ? asUnsignedList(storage.get(K.reserves))
          : (() => {
              const a = asUnsigned(storage.get(K.reserveA));
              const b = asUnsigned(storage.get(K.reserveB));
              return a !== null && b !== null ? [a, b] : null;
            })();
        const totalShares = asUnsigned(storage.get(K.totalShares));
        const shareToken = asAddress(storage.get(K.tokenShare));
        const rewardToken = asAddress(storage.get(K.rewardToken));
        if (
          !tokens ||
          !reserves ||
          tokens.length !== reserves.length ||
          tokens.length < 2 ||
          totalShares === null ||
          !shareToken ||
          !rewardToken
        ) {
          return { status: "unreadable" };
        }
        const killedVal = storage.get(K.isKilledClaim);
        const claimKilled = killedVal !== undefined && scValToNative(killedVal) === true;

        // The account's shares, and which tokens are Stellar Asset Contracts (a trustline is
        // needed to receive those; the reward token is one on both networks).
        const shareKey = balanceKey(shareToken, ctx.account);
        // The reward token is often one of the pool's own tokens (an XLM/AQUA pool pays AQUA); a
        // ledger key may be requested only once per call.
        const distinctTokens = [...new Set([...tokens, rewardToken])];
        const tokenKeys = distinctTokens.map((t) => new Contract(t).getFootprint());
        const second = await readEntries(rpc, [shareKey, ...tokenKeys]);
        // The share token writes a zero balance on a full burn and keeps the entry, so an entry
        // that is present with 0 means "already withdrawn" and an ABSENT entry means the ledger is
        // not telling us the balance. Absent must never read as zero: the round would take "gone"
        // as done and merge the account with its shares still in the pool.
        const shareVal = second.get(shareKey.toXDR("base64"));
        if (!shareVal) return { status: "shares_unreadable" };
        const shares = asUnsigned(shareVal.contractData().val());
        if (shares === null) return { status: "unreadable" };
        const stellarAssetTokens = new Set<string>();
        for (let i = 0; i < tokenKeys.length; i++) {
          const val = second.get(tokenKeys[i]!.toXDR("base64"));
          if (!val) return { status: "unreadable" };
          if (instanceView(val).isStellarAsset) stellarAssetTokens.add(distinctTokens[i]!);
        }

        const reward = await simulateUnsigned(
          rpc,
          ctx.network,
          ctx.account,
          ctx.sequence,
          pool,
          "get_user_reward",
          new Address(ctx.account).toScVal()
        );
        if (reward === null) return { status: "reward_unreadable" };

        return {
          status: "loaded",
          pool,
          poolType,
          tokens,
          reserves,
          totalShares,
          shareToken,
          shares,
          rewardToken,
          reward,
          claimKilled,
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
          "aquarius_contract_not_pool",
          `The Aquarius contract ${pool} holding this position is registered as a ${live.kind}, not ` +
            "a liquidity pool. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "unsupported_pool_type") {
        return manualReview(
          "aquarius_pool_type_unsupported",
          `The Aquarius pool ${pool} is a ${live.version} pool. LumenWipe exits share-based pools ` +
            "(constant-product and stableswap) only; withdraw this position through Aquarius before " +
            "continuing."
        );
      }
      if (live.status === "shares_unreadable") {
        return manualReview(
          "aquarius_shares_unreadable",
          `This account's share balance in Aquarius pool ${pool} is not on the ledger right now - ` +
            "most likely archived after a long idle period. No exit was built so the shares are not " +
            "left behind; restore the entry or withdraw through Aquarius before continuing."
        );
      }
      if (live.status === "reward_unreadable") {
        return manualReview(
          "aquarius_rewards_unreadable",
          `The AQUA rewards accrued to this account's position in Aquarius pool ${pool} could not be ` +
            "read from the network right now, so no exit was built - a merge would lose them. Retry " +
            "the analysis."
        );
      }
      if (live.status === "unreadable") {
        return manualReview(
          "aquarius_pool_unreadable",
          `The Aquarius pool ${pool} could not be read as a liquidity pool right now, so no exit was ` +
            "built. Retry the analysis; if it keeps failing this position needs manual review."
        );
      }
      if (live.shares === 0n && live.reward === 0n) {
        return manualReview(
          EXIT_POSITION_GONE,
          `This account no longer holds shares of Aquarius pool ${pool} and has no rewards left to ` +
            "claim; the position was already withdrawn."
        );
      }

      const native = Asset.native().contractId(NETWORK_PASSPHRASES[ctx.network]);
      const needsTrustline = (token: string): boolean =>
        token !== native && live.stellarAssetTokens.has(token) && !(token in ctx.tokenBalances);
      const blockers: PlanBlocker[] = [];
      const steps: ExitStep[] = [];

      // Rewards first: once the account is merged nobody can come back for them.
      if (live.reward > 0n) {
        if (live.claimKilled) {
          return manualReview(
            "aquarius_rewards_claim_paused",
            `This account has ${live.reward} base units of AQUA accrued in Aquarius pool ${pool}, and ` +
              "the pool's administrator has paused claiming. Closing now would lose them; wait for " +
              "claiming to resume, or withdraw through Aquarius and accept the loss before continuing."
          );
        }
        if (needsTrustline(live.rewardToken)) {
          return manualReview(
            "aquarius_reward_trustline_missing",
            `This account has ${live.reward} base units of AQUA accrued in Aquarius pool ${pool} but no ` +
              "authorized AQUA trustline to receive them. Add the trustline first, or claim through " +
              "Aquarius before continuing."
          );
        }
        steps.push({
          kind: "claim",
          contract: live.pool,
          function: "claim",
          asset: live.rewardToken,
          amount: live.reward.toString(),
          ceiling: live.reward.toString(),
          minReceived: [],
          description: `Claim ${live.reward} base units of AQUA rewards from Aquarius pool ${pool}`,
        });
      }

      if (live.shares > 0n) {
        if (live.totalShares <= 0n) {
          return manualReview(
            "aquarius_pool_unreadable",
            `The Aquarius pool ${pool} reports no shares at all, so this account's shares cannot be ` +
              "valued. No exit was built; this position needs manual review."
          );
        }
        // The account's share of each reserve, exactly as the pool computes it (floor), less the
        // slippage tolerance.
        const floors = live.reserves.map((reserve) =>
          minReceivedFromQuote(
            ((live.shares * reserve) / live.totalShares).toString(),
            ctx.slippageBps
          )
        );
        if (floors.some((f) => f === "0")) {
          return manualReview(
            "aquarius_position_too_small",
            `This account's shares of Aquarius pool ${pool} are worth less than one base unit of one ` +
              "of its tokens after the slippage margin, so no meaningful minimum can be set. Withdraw " +
              "the liquidity through Aquarius before continuing."
          );
        }
        for (const token of live.tokens) {
          if (!needsTrustline(token)) continue;
          blockers.push({
            code: "aquarius_trustline_missing",
            message:
              `Withdrawing from Aquarius pool ${pool} pays out an asset (token contract ` +
              `${shortAddress(token)}) this account has no authorized trustline for, so the ` +
              "withdrawal would fail at the ledger. Add or re-authorize the trustline first, or " +
              "withdraw through Aquarius before continuing.",
          });
        }
        if (blockers.length > 0) return { steps: [], blockers };
        // The LP position is identified by its pool, as detection reports it; the shares burned
        // live in the pool's share token, which the intent and the client verifier name too.
        steps.push({
          kind: "lp_withdraw",
          contract: live.pool,
          function: "withdraw",
          asset: live.pool,
          amount: live.shares.toString(),
          ceiling: live.shares.toString(),
          minReceived: live.tokens.map((token, i) => ({ asset: token, amount: floors[i]! })),
          description:
            `Withdraw all liquidity from Aquarius pool ${pool}: ${live.shares} LP tokens for at least ` +
            live.tokens.map((t, i) => `${floors[i]} of ${shortAddress(t)}`).join(" and "),
        });
      }
      return { steps, blockers: [] };
    },

    health(): null {
      // An LP position carries no debt; there is no health to keep.
      return null;
    },

    hardenBuilt(tx, _step, _live, ctx): Transaction {
      return promoteRewardKeys(tx, ctx.account);
    },

    buildStep(step, live, ctx): BuiltExitStep {
      if (live.status !== "loaded")
        throw new Error("Aquarius: cannot build against an unread pool");
      const user = new Address(ctx.account).toScVal();
      const u128 = (v: string | bigint): xdr.ScVal => nativeToScVal(BigInt(v), { type: "u128" });
      if (step.kind === "claim") {
        return {
          step,
          build: { source: "local", op: new Contract(step.contract).call("claim", user) },
          intent: {
            contract: step.contract,
            function: "claim",
            args: [ctx.account],
            minReceived: [],
            recipient: ctx.account,
          },
        };
      }
      if (step.kind !== "lp_withdraw") throw new Error(`Aquarius: no call for a ${step.kind} step`);
      if (step.minReceived.length !== live.tokens.length) {
        throw new Error("Aquarius: a withdrawal needs one floor per pool token");
      }
      const mins = step.minReceived.map((m) => m.amount);
      return {
        step,
        build: {
          source: "local",
          op: new Contract(step.contract).call(
            "withdraw",
            user,
            u128(step.amount),
            xdr.ScVal.scvVec(mins.map(u128))
          ),
        },
        intent: {
          contract: step.contract,
          function: "withdraw",
          args: [ctx.account, step.amount, ...mins],
          minReceived: step.minReceived,
          recipient: ctx.account,
        },
      };
    },
  };
}
