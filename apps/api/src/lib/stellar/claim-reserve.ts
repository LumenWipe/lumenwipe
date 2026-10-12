import type { AccountState, OpenOffer } from "@lumenwipe/types";
import {
  ACCOUNT_BASE_RESERVE_XLM,
  BASE_FEE_STROOPS,
  BASE_RESERVE_XLM,
  OP_BATCH_LIMIT,
} from "@/config/constants";
import { stroopsToFixedXlm, xlmToStroops } from "@/lib/utils/amounts";

type ReserveAccount = Pick<
  AccountState,
  "nativeBalanceLumens" | "numSubEntries" | "numSponsoring" | "openOffers"
>;

export function minimumBalanceStroops(numSubEntries: number, numSponsoring: number): bigint {
  return (
    BigInt(xlmToStroops(ACCOUNT_BASE_RESERVE_XLM.toFixed(7))) +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) * BigInt(numSubEntries + numSponsoring)
  );
}

/** Whether the account itself, rather than the fee sponsor, pays a transaction's fee. */
export function accountPaysFee(remaining: bigint, reserve: bigint, feeStroops: bigint): boolean {
  return remaining - reserve >= feeStroops;
}

function nativeSellingLiabilities(offers: OpenOffer[]): bigint {
  let total = 0n;
  for (const offer of offers) {
    if (offer.selling === "native") total += BigInt(xlmToStroops(offer.amount));
  }
  return total;
}

function ownFeesStroops(balance: bigint, reserve: bigint, opCount: number): bigint {
  let remaining = balance;
  let paid = 0n;
  for (let left = opCount; left > 0; left -= OP_BATCH_LIMIT) {
    const fee = BigInt(BASE_FEE_STROOPS) * BigInt(Math.min(left, OP_BATCH_LIMIT));
    if (!accountPaysFee(remaining, reserve, fee)) continue;
    remaining -= fee;
    paid += fee;
  }
  return paid;
}

/**
 * The XLM the account is short of to add `newTrustlines` trustlines and claim in one atomic
 * round, or 0n when it has the headroom. The new reserves, the XLM held back by open sell
 * offers and the fees the account pays itself all have to fit above the current minimum balance;
 * a fee the sponsor pays is not counted. Short, the ledger fails the trustline with
 * `op_low_reserve` and the whole round reverts with it.
 */
export function trustlineReserveShortfallStroops(
  account: ReserveAccount,
  newTrustlines: number,
  claimOps: number
): bigint {
  const balance = BigInt(xlmToStroops(account.nativeBalanceLumens));
  const reserve = minimumBalanceStroops(account.numSubEntries, account.numSponsoring);
  const needed =
    reserve +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) * BigInt(newTrustlines) +
    nativeSellingLiabilities(account.openOffers) +
    ownFeesStroops(balance, reserve, claimOps + newTrustlines);
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
