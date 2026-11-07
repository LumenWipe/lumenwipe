import type { PlannedStep } from "@/types/plan";
import { xlmToStroops } from "@/lib/utils/amounts";

const LUMENS = /^\d+(?:\.\d{1,7})?$/;

/** A step's estimated fee in whole stroops; null for a value that is not an amount of XLM. */
export function stepFeeStroops(step: Pick<PlannedStep, "estimatedFeeLumens">): bigint | null {
  // The value comes from an API response: a JSON number must not reach xlmToStroops.
  const fee: unknown = step.estimatedFeeLumens;
  return typeof fee === "string" && LUMENS.test(fee) ? BigInt(xlmToStroops(fee)) : null;
}

/** The plan's network fees: the exact sum of its steps' fees, in stroops. Null when any step's
 *  fee is unreadable: a total that silently left one out would understate what the user pays. */
export function totalFeeStroops(
  steps: readonly Pick<PlannedStep, "estimatedFeeLumens">[]
): string | null {
  let total = BigInt(0);
  for (const step of steps) {
    const fee = stepFeeStroops(step);
    if (fee === null) return null;
    total += fee;
  }
  return total.toString();
}

/** How many wallet approvals to expect. The builder may add a transaction at build time, so the
 *  count is only ever "about", and "at least 1" when the plan cannot know it yet. */
export function transactionCountLine(count: number | null): string {
  if (count === null)
    return "At least 1 transaction to sign. The exact number is known once signing starts.";
  return `About ${count} ${count === 1 ? "transaction" : "transactions"} to sign (this can change if your account changes).`;
}
