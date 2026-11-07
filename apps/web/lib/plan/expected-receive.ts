import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import { classicFloorFromQuote } from "@/lib/api/close-decisions";
import { xlmToStroops } from "@/lib/utils/amounts";
import { BASE_FEE_STROOPS } from "@/config/constants";

/** What a close is expected to deliver, in stroops, and the lines that add up to it. Display
 *  only: none of it is sent to the API or used to check a transaction. */
export interface ExpectedReceive {
  /** `balanceStroops - feeStroops + swapStroops + claimStroops`. */
  totalStroops: string;
  balanceStroops: string;
  /** The part of the balance the reserves hold until the close frees it; already in the balance. */
  reserveStroops: string;
  feeStroops: string;
  /** The least the chosen swaps to XLM may deliver. */
  swapStroops: string;
  /** The XLM claimable balances the close will claim. */
  claimStroops: string;
  /** A swap or a claim adds to the figure, so it depends on what the market and the ledger do. */
  estimated: boolean;
  /** Chosen swaps whose plan carried no estimate, so the figure counts nothing for them. */
  unquotedSwaps: number;
  /** Chosen token swaps: each pays a Soroban resource fee the plan's fee estimate does not hold. */
  tokenSwaps: number;
  /** Chosen token swaps whose quote was flagged (a high or unmeasured price impact, or quotes
   *  that disagree) and that the user confirmed anyway. */
  flaggedSwaps: number;
  /** The account holds DeFi positions whose exits may pay XLM the figure does not count. */
  leavesOutDefiExits: boolean;
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
}

const ZERO = BigInt(0);
const RESERVE_UNIT_STROOPS = BigInt(5_000_000);

function stroopsOf(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : ZERO;
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

  let swaps = ZERO;
  let unquotedSwaps = 0;
  let tokenSwaps = 0;
  let flaggedSwaps = 0;
  for (const c of input.conversions) {
    if (!c.convertible || input.dispositions[c.asset] !== "convert") continue;
    if (c.token) tokenSwaps += 1;
    if ((c.token?.quote?.flags.length ?? 0) > 0) flaggedSwaps += 1;
    const floor = c.token
      ? c.token.quote?.minAmountOut
      : c.quote
        ? classicFloorFromQuote(c.quote.minAmountOut)
        : undefined;
    if (floor === undefined) unquotedSwaps += 1;
    else swaps += stroopsOf(floor);
  }

  let claims = ZERO;
  for (const b of input.claims) {
    if (b.asset !== "native" || !b.currentlyClaimable) continue;
    if (input.claimSelections[b.balanceId] === "forfeit") continue;
    claims += BigInt(xlmToStroops(b.amount));
  }

  return {
    totalStroops: (balance - fee + swaps + claims).toString(),
    balanceStroops: balance.toString(),
    reserveStroops: reserve.toString(),
    feeStroops: fee.toString(),
    swapStroops: swaps.toString(),
    claimStroops: claims.toString(),
    estimated: swaps > ZERO || claims > ZERO,
    unquotedSwaps,
    tokenSwaps,
    flaggedSwaps,
    leavesOutDefiExits: account.defiPositions.positions.length > 0,
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
    BigInt(expected.claimStroops);
  return { ...expected, feeStroops, totalStroops: total.toString() };
}
