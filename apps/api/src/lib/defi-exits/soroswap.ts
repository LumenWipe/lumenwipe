import { Address, Asset, Contract, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { DefiPosition, PlanBlocker, SoroswapLpPosition } from "@lumenwipe/types";
import { TX_TIMEOUT_SECONDS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { entriesForNetwork } from "@/lib/contract-registry";
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
 * Soroswap exit (architecture.md §9.5): an LP position leaves through the router's
 * `remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to, deadline)`,
 * which pulls the account's LP tokens into the pair and pays both reserves back to `to`. Built
 * locally against the router the registry vouches for and simulated by the runner, like every
 * other exit - the Soroswap API is not consulted, so no third-party bytes are ever signed.
 *
 * Everything the plan needs is read straight from the ledger: the pair's instance holds its two
 * tokens (keys 0 and 1), both reserves (keys 2 and 3), and `TotalSupply`; the account's shares
 * are the pair's SEP-41 `Balance(account)`. The share of each reserve the account is owed is
 * `shares × reserve / totalSupply`, and the floors the router must honor are that share less the
 * slippage tolerance - a fresh quote from the very state the exit will execute against.
 */

export interface SoroswapPairState {
  pair: string;
  router: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  /** The account's LP tokens, base units (7 decimals). */
  shares: bigint;
  /** Tokens that are Stellar Asset Contracts: receiving one needs a trustline for its asset. */
  stellarAssetTokens: Set<string>;
}

export type SoroswapLive =
  | ({ status: "loaded" } & SoroswapPairState)
  | { status: "not_pair"; kind: string }
  | { status: "no_router" }
  | { status: "unreadable" };

export interface SoroswapDeps {
  /** The registry's router for a network, or null when none is verified there. */
  routerFor(network: keyof typeof NETWORK_PASSPHRASES): string | null;
}

export const defaultSoroswapDeps: SoroswapDeps = {
  routerFor(network) {
    const router = entriesForNetwork(network).find(
      (e) => e.protocol === "soroswap" && e.kind === "router" && e.verifiedLive
    );
    return router?.address ?? null;
  },
};

/** Pair instance storage keys, as the pair contract declares them (soroswap/core contracts/pair). */
const KEY_TOKEN_0 = "0";
const KEY_TOKEN_1 = "1";
const KEY_RESERVE_0 = "2";
const KEY_RESERVE_1 = "3";
const KEY_TOTAL_SUPPLY = '["TotalSupply"]';

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

const asI128 = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  return typeof native === "bigint" ? native : null;
};

async function readEntries(
  rpc: ExitRpc,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const res = await rpc.getLedgerEntries(...keys);
  const out = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) out.set(entry.key.toXDR("base64"), entry.val);
  return out;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function manualReview(code: string, message: string): ExitPlan {
  const blocker: PlanBlocker = { code, message };
  return { steps: [], blockers: [blocker] };
}

export function soroswapExitAdapter(
  deps: SoroswapDeps = defaultSoroswapDeps
): ExitAdapter<SoroswapLpPosition, SoroswapLive> {
  return {
    protocol: "soroswap",

    supports(position: DefiPosition): position is SoroswapLpPosition {
      return position.protocol === "soroswap" && position.positionType === "lp";
    },

    async readLive(position, code, ctx, rpc): Promise<SoroswapLive> {
      if (code.kind !== "pair") return { status: "not_pair", kind: code.kind };
      const router = deps.routerFor(ctx.network);
      if (router === null) return { status: "no_router" };

      try {
        const pair = position.contractAddress;
        const instanceKey = new Contract(pair).getFootprint();
        const balanceKey = xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(pair).toScAddress(),
            key: xdr.ScVal.scvVec([
              xdr.ScVal.scvSymbol("Balance"),
              new Address(ctx.account).toScVal(),
            ]),
            durability: xdr.ContractDataDurability.persistent(),
          })
        );
        const first = await readEntries(rpc, [instanceKey, balanceKey]);
        const instanceVal = first.get(instanceKey.toXDR("base64"));
        if (!instanceVal) return { status: "unreadable" };
        const { storage } = instanceView(instanceVal);
        const token0 = asAddress(storage.get(KEY_TOKEN_0));
        const token1 = asAddress(storage.get(KEY_TOKEN_1));
        const reserve0 = asI128(storage.get(KEY_RESERVE_0));
        const reserve1 = asI128(storage.get(KEY_RESERVE_1));
        const totalSupply = asI128(storage.get(KEY_TOTAL_SUPPLY));
        if (!token0 || !token1 || reserve0 === null || reserve1 === null || totalSupply === null) {
          return { status: "unreadable" };
        }
        const balanceVal = first.get(balanceKey.toXDR("base64"));
        const shares = balanceVal ? asI128(balanceVal.contractData().val()) : 0n;
        if (shares === null) return { status: "unreadable" };

        // Which of the two tokens are Stellar Asset Contracts decides whether the account needs
        // a trustline to receive them; a Soroban-native token needs nothing.
        const tokenKeys = [
          new Contract(token0).getFootprint(),
          new Contract(token1).getFootprint(),
        ];
        const tokens = await readEntries(rpc, tokenKeys);
        const stellarAssetTokens = new Set<string>();
        for (const [token, key] of [
          [token0, tokenKeys[0]!],
          [token1, tokenKeys[1]!],
        ] as const) {
          const val = tokens.get(key.toXDR("base64"));
          if (!val) return { status: "unreadable" };
          if (instanceView(val).isStellarAsset) stellarAssetTokens.add(token);
        }

        return {
          status: "loaded",
          pair,
          router,
          token0,
          token1,
          reserve0,
          reserve1,
          totalSupply,
          shares,
          stellarAssetTokens,
        };
      } catch {
        return { status: "unreadable" };
      }
    },

    plan(position, live, _code, ctx): ExitPlan {
      const pair = shortAddress(position.contractAddress);
      if (live.status === "not_pair") {
        return manualReview(
          "soroswap_contract_not_pair",
          `The Soroswap contract ${pair} holding this position is registered as a ${live.kind}, not ` +
            "a liquidity pair. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "no_router") {
        return manualReview(
          "soroswap_router_unknown",
          `LumenWipe has no verified Soroswap router on ${ctx.network}, so this position cannot be ` +
            "exited here yet. Withdraw the liquidity through Soroswap before continuing."
        );
      }
      if (live.status === "unreadable") {
        return manualReview(
          "soroswap_pair_unreadable",
          `The Soroswap pair ${pair} could not be read as a liquidity pair right now, so no exit ` +
            "was built. Retry the analysis; if it keeps failing this position needs manual review."
        );
      }
      if (live.shares === 0n) {
        return manualReview(
          EXIT_POSITION_GONE,
          `This account no longer holds shares of Soroswap pair ${pair}; the position was already ` +
            "withdrawn."
        );
      }
      if (live.totalSupply <= 0n) {
        return manualReview(
          "soroswap_pair_unreadable",
          `The Soroswap pair ${pair} reports no liquidity at all, so this account's shares cannot ` +
            "be valued. No exit was built; this position needs manual review."
        );
      }

      // The account's share of each reserve, exactly as the pair will compute it (floor).
      const owed0 = (live.shares * live.reserve0) / live.totalSupply;
      const owed1 = (live.shares * live.reserve1) / live.totalSupply;
      const min0 = minReceivedFromQuote(owed0.toString(), ctx.slippageBps);
      const min1 = minReceivedFromQuote(owed1.toString(), ctx.slippageBps);
      if (min0 === "0" || min1 === "0") {
        return manualReview(
          "soroswap_position_too_small",
          `This account's shares of Soroswap pair ${pair} are worth less than one base unit of one ` +
            "of its tokens after the slippage margin, so no meaningful minimum can be set. Withdraw " +
            "the liquidity through Soroswap before continuing."
        );
      }

      // Receiving a classic asset through its Stellar Asset Contract requires a trustline; a
      // withdrawal into an account without one fails at the ledger. Native XLM never needs one.
      const native = Asset.native().contractId(NETWORK_PASSPHRASES[ctx.network]);
      const blockers: PlanBlocker[] = [];
      for (const token of [live.token0, live.token1]) {
        if (token === native || !live.stellarAssetTokens.has(token)) continue;
        if (!(token in ctx.tokenBalances)) {
          blockers.push({
            code: "soroswap_trustline_missing",
            message:
              `Withdrawing from Soroswap pair ${pair} pays out an asset (token contract ` +
              `${shortAddress(token)}) this account has no trustline for, so the withdrawal would ` +
              "fail. Add the trustline first, or withdraw through Soroswap before continuing.",
          });
        }
      }
      if (blockers.length > 0) return { steps: [], blockers };

      const step: ExitStep = {
        kind: "lp_withdraw",
        contract: live.router,
        function: "remove_liquidity",
        asset: live.pair,
        amount: live.shares.toString(),
        ceiling: live.shares.toString(),
        minReceived: [
          { asset: live.token0, amount: min0 },
          { asset: live.token1, amount: min1 },
        ],
        description:
          `Withdraw all liquidity from Soroswap pair ${pair}: ${live.shares} LP tokens for at least ` +
          `${min0} of ${shortAddress(live.token0)} and ${min1} of ${shortAddress(live.token1)}`,
      };
      return { steps: [step], blockers: [] };
    },

    health(): null {
      // An LP position carries no debt; there is no health to keep.
      return null;
    },

    buildStep(step, live, ctx): BuiltExitStep {
      if (live.status !== "loaded")
        throw new Error("Soroswap: cannot build against an unread pair");
      if (step.kind !== "lp_withdraw") throw new Error(`Soroswap: no call for a ${step.kind} step`);
      const [floor0, floor1] = step.minReceived;
      if (!floor0 || !floor1) throw new Error("Soroswap: a withdrawal needs both floors");
      const deadline = BigInt(Math.floor(ctx.now.getTime() / 1000) + TX_TIMEOUT_SECONDS);
      const i128 = (v: string | bigint): xdr.ScVal => nativeToScVal(BigInt(v), { type: "i128" });
      const op = new Contract(step.contract).call(
        "remove_liquidity",
        new Address(live.token0).toScVal(),
        new Address(live.token1).toScVal(),
        i128(step.amount),
        i128(floor0.amount),
        i128(floor1.amount),
        new Address(ctx.account).toScVal(),
        nativeToScVal(deadline, { type: "u64" })
      );
      return {
        step,
        build: { source: "local", op },
        intent: {
          contract: step.contract,
          function: "remove_liquidity",
          args: [
            live.token0,
            live.token1,
            step.amount,
            floor0.amount,
            floor1.amount,
            ctx.account,
            deadline.toString(),
          ],
          minReceived: step.minReceived,
          recipient: ctx.account,
        },
      };
    },
  };
}
