import type { AccountState, OpenOffer } from "@lumenwipe/types";
import {
  ACCOUNT_BASE_RESERVE_XLM,
  BASE_FEE_STROOPS,
  BASE_RESERVE_XLM,
  SOROBAN_EXIT_FEE_ESTIMATE_STROOPS,
} from "@/config/constants";
import { stroopsToFixedXlm, xlmToStroops } from "@/lib/utils/amounts";

/** The account state a fee is judged against: balance, reserve and the XLM held by open offers. */
export type FeeAffordability = Pick<
  AccountState,
  "nativeBalanceLumens" | "numSubEntries" | "numSponsoring" | "numSponsored" | "openOffers"
>;

export function minimumBalanceStroops(
  numSubEntries: number,
  numSponsoring: number,
  numSponsored = 0
): bigint {
  const minimum =
    BigInt(xlmToStroops(ACCOUNT_BASE_RESERVE_XLM.toFixed(7))) +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) *
      BigInt(numSubEntries + numSponsoring - numSponsored);
  return minimum > 0n ? minimum : 0n;
}

/** Whether the account itself, rather than the fee sponsor, pays a transaction's fee. */
export function accountPaysFee(remaining: bigint, reserve: bigint, feeStroops: bigint): boolean {
  return remaining - reserve >= feeStroops;
}

/** XLM held by open offers selling XLM. The ledger counts it as unavailable when it charges a
 *  fee, exactly like the reserve. */
export function nativeSellingLiabilities(offers: OpenOffer[]): bigint {
  let total = 0n;
  for (const offer of offers) {
    if (offer.selling === "native") total += BigInt(xlmToStroops(offer.amount));
  }
  return total;
}

/** What the account must keep untouched when it pays a fee itself: its reserve plus the XLM its
 *  open offers are selling. */
export function feeFloorStroops(
  account: Pick<AccountState, "numSubEntries" | "numSponsoring" | "numSponsored" | "openOffers">
): bigint {
  return (
    minimumBalanceStroops(account.numSubEntries, account.numSponsoring, account.numSponsored ?? 0) +
    nativeSellingLiabilities(account.openOffers)
  );
}

/** Stroops the account is short of to pay `ownFeesStroops` from what it holds above its reserve
 *  and its offers' XLM, or 0n when it can. */
export function ownFeeShortfallStroops(state: FeeAffordability, ownFeesStroops: bigint): bigint {
  const spare = BigInt(xlmToStroops(state.nativeBalanceLumens)) - feeFloorStroops(state);
  return spare >= ownFeesStroops ? 0n : ownFeesStroops - spare;
}

/** The exchange merge carries two operations at the base fee, and no sponsor can pay it. */
export const MEDIATOR_TX_FEE_STROOPS = BigInt(2 * BASE_FEE_STROOPS);

/** The least the mediator forwards (its co-sign refuses less), so the least balance the exchange
 *  merge can start from is this plus its own fee. */
export const MEDIATOR_MIN_FORWARD_STROOPS = BigInt(xlmToStroops("1"));

/** Classic operations the close may still need, each counted at its worst case. */
function classicOpsBound(state: AccountState): number {
  return (
    state.signers.length +
    state.dataEntries.length +
    state.openOffers.length +
    2 * state.trustlines.length +
    2 * state.claimableBalances.length +
    state.sponsoredEntries.length +
    1
  );
}

/** Soroban token balances the close will move: held, and not answered `leave`. */
export function tokenRoundsAhead(
  state: AccountState,
  dispositions: Record<string, string>,
  only?: "convert"
): number {
  return (state.sorobanTokens?.tokens ?? []).filter((t) => {
    const d = dispositions[t.contract];
    if (BigInt(t.balance) <= 0n || d === "leave") return false;
    return only ? d === only : true;
  }).length;
}

/**
 * What the account must still pay itself after the round being built: later Soroban rounds at
 * the plan's per-transaction estimate, every classic operation at the base fee (whether a sponsor
 * takes it is not known yet) and, for an exchange, the merge.
 */
export function laterOwnFeesStroops(
  state: AccountState,
  laterSorobanRounds: number,
  viaMediator: boolean
): bigint {
  return (
    BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS) * BigInt(laterSorobanRounds) +
    BigInt(BASE_FEE_STROOPS) * BigInt(classicOpsBound(state)) +
    (viaMediator ? MEDIATOR_TX_FEE_STROOPS : 0n)
  );
}

export function closeFeeShortMessage(shortStroops: bigint): string {
  return (
    `This account needs at least ${stroopsToFixedXlm(shortStroops)} XLM more than it has to ` +
    "spare above its reserve to pay the network fees of the remaining steps, which no sponsor " +
    "can cover. Add that much XLM to the account, then continue the close."
  );
}

/**
 * The XLM the account is short of to add `newTrustlines` trustlines and claim in one atomic
 * round, or 0n when it has the headroom. The new reserves, the XLM held back by open sell
 * offers and the round's fees all have to fit above the current minimum balance. The fees are
 * the account's own: a round that opens a trustline is not one the fee sponsor pays for. Short,
 * the ledger fails the trustline with `op_low_reserve` and the whole round reverts with it.
 */
export function trustlineReserveShortfallStroops(
  account: FeeAffordability,
  newTrustlines: number,
  claimOps: number
): bigint {
  const balance = BigInt(xlmToStroops(account.nativeBalanceLumens));
  const needed =
    feeFloorStroops(account) +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) * BigInt(newTrustlines) +
    BigInt(BASE_FEE_STROOPS) * BigInt(claimOps + newTrustlines);
  return needed > balance ? needed - balance : 0n;
}

export function trustlineShortfallNote(code: string, shortfallStroops: bigint): string {
  return (
    `Adding a ${code} trustline needs ${stroopsToFixedXlm(shortfallStroops)} XLM more than this ` +
    `account has to spare above its reserve.`
  );
}

export function claimReserveShortMessage(shortfallStroops: bigint): string {
  return (
    `Adding the trustlines needed to claim these balances takes ${stroopsToFixedXlm(shortfallStroops)} ` +
    `XLM more than this account has to spare above its reserve, so the claim would fail.`
  );
}
