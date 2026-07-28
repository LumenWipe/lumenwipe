import { xlmToStroops } from "@/lib/utils/amounts";

/**
 * True when the mediator forward payment (op1) would send out more than the account
 * merge (op0) delivers into the mediator: the merged account's native balance minus the
 * transaction fee the merge consumes. An `accountMerge` transfers the source's entire XLM
 * balance (reserves are freed as the account is deleted), so the delivered amount is the
 * full native balance, not just the spendable portion. Stroop (BigInt) arithmetic, exact.
 *
 * DEFENSE-IN-DEPTH, NOT A COMPLETE GUARANTEE. The caller of `mediator/sign` passes the
 * balance-bearing transaction, but the bound is checked against a balance read at co-sign
 * time while the merge's actual delivery is decided at submit time, which the caller
 * controls: they can drain the merged account after the co-sign (an operation sourced from
 * that account does not consume the co-signed transaction's sequence number), then submit,
 * so op0 delivers ~0 while op1 forwards the co-signed amount out of the mediator's own
 * balance. An active adversary who controls the merged account can therefore still forward
 * up to the mediator's spendable surplus. The primary protection remains the operational
 * invariant that the shared mediator holds no spendable surplus (funded to its base reserve
 * only) plus balance monitoring; this bound stops the passive cases — a client bug, dust,
 * or a naive over-forward — and raises the bar otherwise.
 */
export function forwardExceedsMergedBalance(
  forwardAmountLumens: string,
  mergedNativeBalanceLumens: string,
  txFeeStroops: number
): boolean {
  const forward = BigInt(xlmToStroops(forwardAmountLumens));
  const delivered = BigInt(xlmToStroops(mergedNativeBalanceLumens)) - BigInt(txFeeStroops);
  return forward > delivered;
}
