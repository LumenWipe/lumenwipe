import type { PlanResponse } from "@lumenwipe/sdk";
import type { DefiProtocol, ExitPayoutEstimate } from "@lumenwipe/types";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import {
  decisionPointsToClaimableBalances,
  decisionPointsToConversions,
  exitPayoutsOf,
  planFeeStroopsOf,
  type AssetConvertibility,
  type ClaimableBalanceDecision,
} from "@/lib/api/plan-adapters";
import { hardBlockersOf } from "@/lib/plan/resolvable-blockers";
import { classicFloorFromQuote } from "@/lib/api/close-decisions";
import { xlmToStroops } from "@/lib/utils/amounts";
import { BASE_FEE_STROOPS } from "@/config/constants";

/** What a close is expected to deliver, in stroops, and the lines that add up to it. Display
 *  only: none of it is sent to the API or used to check a transaction. */
export interface ExpectedReceive {
  /** `balanceStroops - feeStroops + swapStroops + claimStroops + exitStroops`. */
  totalStroops: string;
  balanceStroops: string;
  /** The part of the balance the reserves hold until the close frees it; already in the balance. */
  reserveStroops: string;
  feeStroops: string;
  /** The least the chosen swaps to XLM may deliver. */
  swapStroops: string;
  /** The XLM claimable balances the close will claim. */
  claimStroops: string;
  /** The least the DeFi exits pay in: their XLM, and the floor of each paid-in asset chosen to
   *  be swapped. Negative when an exit spends more than it pays in. */
  exitStroops: string;
  /** A swap or a claim adds to the figure, so it depends on what the market and the ledger do. */
  estimated: boolean;
  /** Chosen swaps whose plan carried no estimate, so the figure counts nothing for them. */
  unquotedSwaps: number;
  /** Chosen token swaps whose quote was flagged (a high or unmeasured price impact, or quotes
   *  that disagree) and that the user confirmed anyway. */
  flaggedSwaps: number;
  /** The account holds DeFi positions whose exits may pay XLM the figure does not count. */
  leavesOutDefiExits: boolean;
  /** The exits the figure counts nothing for, when the plan named them. */
  uncomputedExits: ExitTargetRef[];
}

export interface ExitTargetRef {
  protocol: DefiProtocol;
  contract: string;
}

export interface ExpectedReceiveInput {
  account: Pick<
    AccountState,
    "nativeBalanceLumens" | "numSubEntries" | "numSponsoring" | "numSponsored" | "defiPositions"
  >;
  /** The plan's own `estimate.feeStroops`. */
  planFeeStroops: string;
  /** The destination needs the relay account, and the plan the fee came from was built before
   *  that was known, so it did not count the forward payment's operation. */
  relayForwardUncounted: boolean;
  conversions: readonly AssetConvertibility[];
  dispositions: Readonly<Record<string, AssetDisposition>>;
  claims: readonly ClaimableBalanceDecision[];
  claimSelections: Readonly<Record<string, ClaimableBalanceSelection>>;
  /** The plan's `estimate.exitPayouts`; without it every DeFi exit is left out. */
  exitPayouts?: ExitPayoutEstimate | null;
}

const ZERO = BigInt(0);
const RESERVE_UNIT_STROOPS = BigInt(5_000_000);

function stroopsOf(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : ZERO;
}

interface ExitsCounted {
  stroops: bigint;
  uncomputed: ExitTargetRef[];
  /** Assets whose swap the exit line values in full, so a missing plan quote is not a gap. */
  valued: Set<string>;
}

/**
 * What the exits add: every XLM part, and for each paid-in asset chosen to be swapped, the floor
 * of the quote for what it will hold after the exits less the floor already counted for what it
 * holds now. An exit with a swapped asset that has no such quote counts nothing and is named.
 */
function countExits(
  exits: ExitPayoutEstimate,
  conversions: readonly AssetConvertibility[],
  dispositions: Readonly<Record<string, AssetDisposition>>
): ExitsCounted {
  const swapped = (asset: string) => asset !== "native" && dispositions[asset] === "convert";
  const unquoted = new Set(
    exits.targets.flatMap((t) =>
      (t.parts ?? []).filter((p) => swapped(p.asset) && !exits.quotes[p.asset]).map((p) => p.asset)
    )
  );
  let stroops = ZERO;
  const uncomputed: ExitTargetRef[] = [];
  const netByAsset = new Map<string, bigint>();
  for (const { protocol, contract, parts } of exits.targets) {
    if (parts === null || parts.some((p) => unquoted.has(p.asset))) {
      uncomputed.push({ protocol, contract });
      continue;
    }
    for (const { asset, stroops: amount } of parts) {
      if (asset === "native") stroops += BigInt(amount);
      else if (swapped(asset))
        netByAsset.set(asset, (netByAsset.get(asset) ?? ZERO) + BigInt(amount));
    }
  }
  for (const [asset, net] of netByAsset) {
    const held = conversions.find((c) => c.asset === asset)?.quote;
    const value =
      BigInt(classicFloorFromQuote(exits.quotes[asset]!.minAmountOut)) -
      (held ? BigInt(classicFloorFromQuote(held.minAmountOut)) : ZERO);
    // Two quotes taken moments apart: a larger amount quoting lower is noise, never a loss.
    stroops += net > ZERO && value < ZERO ? ZERO : value;
  }
  return { stroops, uncomputed, valued: new Set(netByAsset.keys()) };
}

/**
 * The XLM a close is expected to deliver at its destination. Every amount is whole stroops. Where
 * a figure is not known exactly it leans low: each swap counts its floor, not its quote, and a
 * swap with no estimate counts nothing. The relay account keeps nothing: its forward pays on the
 * merged balance less the merge transaction's fee, which the fee line already holds.
 */
export function expectedReceive(input: ExpectedReceiveInput): ExpectedReceive {
  const { account } = input;
  const balance = BigInt(xlmToStroops(account.nativeBalanceLumens));
  const reserveEntries =
    BigInt(2) +
    BigInt(account.numSubEntries) +
    BigInt(account.numSponsoring) -
    BigInt(account.numSponsored ?? 0);
  const reserveFull = reserveEntries > ZERO ? reserveEntries * RESERVE_UNIT_STROOPS : ZERO;
  const reserve = reserveFull < balance ? reserveFull : balance;

  const fee =
    stroopsOf(input.planFeeStroops) +
    (input.relayForwardUncounted ? BigInt(BASE_FEE_STROOPS) : ZERO);

  const exits: ExitsCounted = input.exitPayouts
    ? countExits(input.exitPayouts, input.conversions, input.dispositions)
    : { stroops: ZERO, uncomputed: [], valued: new Set() };

  let swaps = ZERO;
  let unquotedSwaps = 0;
  let flaggedSwaps = 0;
  for (const c of input.conversions) {
    if (!c.convertible || input.dispositions[c.asset] !== "convert") continue;
    if ((c.token?.quote?.flags.length ?? 0) > 0) flaggedSwaps += 1;
    const floor = c.token
      ? c.token.quote?.minAmountOut
      : c.quote
        ? classicFloorFromQuote(c.quote.minAmountOut)
        : undefined;
    if (floor === undefined) {
      if (!exits.valued.has(c.asset)) unquotedSwaps += 1;
    } else swaps += stroopsOf(floor);
  }

  let claims = ZERO;
  for (const b of input.claims) {
    if (b.asset !== "native" || !b.currentlyClaimable) continue;
    if (input.claimSelections[b.balanceId] === "forfeit") continue;
    claims += BigInt(xlmToStroops(b.amount));
  }

  return {
    totalStroops: (balance - fee + swaps + claims + exits.stroops).toString(),
    balanceStroops: balance.toString(),
    reserveStroops: reserve.toString(),
    feeStroops: fee.toString(),
    swapStroops: swaps.toString(),
    claimStroops: claims.toString(),
    exitStroops: exits.stroops.toString(),
    estimated: swaps > ZERO || claims > ZERO || exits.stroops !== ZERO,
    unquotedSwaps,
    flaggedSwaps,
    leavesOutDefiExits: input.exitPayouts
      ? exits.uncomputed.length > 0
      : account.defiPositions.positions.length > 0,
    uncomputedExits: exits.uncomputed,
  };
}

/**
 * The same figure with `feeStroops` as its fee line, so a screen showing one fee total shows one
 * fee everywhere. Every other line stays as it was, and the total is their sum again.
 */
export function withFeeStroops(expected: ExpectedReceive, feeStroops: string): ExpectedReceive {
  const total =
    BigInt(expected.balanceStroops) -
    BigInt(feeStroops) +
    BigInt(expected.swapStroops) +
    BigInt(expected.claimStroops) +
    BigInt(expected.exitStroops);
  return { ...expected, feeStroops, totalStroops: total.toString() };
}

/** The range a close of an account could recover, before any decision is made. Display only. */
export interface RecoveryRange {
  /** The XLM balance less the plan's fees, plus the XLM the DeFi exits pay in: what a close
   *  recovers with no conversions and no claims. Never below zero. */
  lowStroops: string;
  /** The low figure plus the floor of every quoted conversion, including what the exits pay in,
   *  and the XLM claimable balances. */
  highStroops: string;
  feeStroops: string;
  /** Assets the high figure converts. */
  convertedAssets: number;
  /** Convertible assets with no quote, which the high figure counts as nothing. */
  unquotedSwaps: number;
  /** Assets with no route to XLM, which neither figure counts. */
  unconvertibleAssets: number;
  /** DeFi position exits that may pay XLM neither figure counts. */
  leavesOutDefiExits: boolean;
  /** Plan blockers that would stop the close, as the analyze screen counts them. */
  blockers: number;
}

/**
 * The recovery range of a destination-less plan, from `expectedReceive` twice: once with every
 * asset left alone, once with every convertible asset converted and every XLM claimable balance
 * claimed. The destination is not known, so the relay account's forward fee is counted, which
 * leans low. Null when the plan carries no usable fee, since no figure is shown without one.
 */
export function recoveryRange(
  account: ExpectedReceiveInput["account"],
  plan: PlanResponse
): RecoveryRange | null {
  const planFeeStroops = planFeeStroopsOf(plan);
  if (planFeeStroops === null) return null;
  const conversions = decisionPointsToConversions(plan);
  const claims = decisionPointsToClaimableBalances(plan);
  const base = {
    account,
    planFeeStroops,
    relayForwardUncounted: true,
    conversions,
    exitPayouts: exitPayoutsOf(plan),
  };

  const low = expectedReceive({ ...base, dispositions: {}, claims: [], claimSelections: {} });
  const convertible = conversions.filter((c) => c.convertible);
  const high = expectedReceive({
    ...base,
    dispositions: Object.fromEntries(convertible.map((c) => [c.asset, "convert" as const])),
    claims,
    claimSelections: Object.fromEntries(
      claims.map((b) => [b.balanceId, b.offered.includes("claim") ? "claim" : "forfeit"] as const)
    ),
  });

  const atLeastZero = (stroops: string) => (BigInt(stroops) > ZERO ? stroops : "0");
  return {
    lowStroops: atLeastZero(low.totalStroops),
    highStroops: atLeastZero(high.totalStroops),
    feeStroops: low.feeStroops,
    convertedAssets: convertible.length,
    unquotedSwaps: high.unquotedSwaps,
    unconvertibleAssets: conversions.length - convertible.length,
    leavesOutDefiExits: high.leavesOutDefiExits,
    blockers: hardBlockersOf(plan.blockers).length,
  };
}
