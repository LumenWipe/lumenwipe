import {
  FEE_BUMP_DAILY_BUDGET_PER_KEY_STROOPS,
  FEE_BUMP_DAILY_BUDGET_PER_SOURCE_STROOPS,
  FEE_BUMP_DAILY_BUDGET_TOTAL_STROOPS,
} from "@/config/constants";

export interface SponsorshipBudgetLimits {
  perSource: bigint;
  perKey: bigint;
  total: bigint;
}

export const DEFAULT_SPONSORSHIP_LIMITS: SponsorshipBudgetLimits = {
  perSource: BigInt(FEE_BUMP_DAILY_BUDGET_PER_SOURCE_STROOPS),
  perKey: BigInt(FEE_BUMP_DAILY_BUDGET_PER_KEY_STROOPS),
  total: BigInt(FEE_BUMP_DAILY_BUDGET_TOTAL_STROOPS),
};

export type BudgetScope = "source" | "key" | "total";

/**
 * Fees the sponsor has signed for in the current UTC day. A fee counts when it is signed, not
 * when it lands, so an envelope that is never submitted still uses budget: the signature is
 * what can be spent.
 *
 * In-process, like the request throttler: the API runs as one instance, and a restart grants a
 * fresh day's budget, which the per-transaction cap and the fee account's small float bound.
 */
export class SponsorshipBudget {
  private day = "";
  private total = 0n;
  private readonly bySource = new Map<string, bigint>();
  private readonly byKey = new Map<string, bigint>();

  constructor(private readonly limits: SponsorshipBudgetLimits = DEFAULT_SPONSORSHIP_LIMITS) {}

  /** Records `fee` against every scope and returns null, or names the first scope it would
   *  exceed and records nothing. */
  reserve(source: string, key: string, fee: bigint, now: Date): BudgetScope | null {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0n;
      this.bySource.clear();
      this.byKey.clear();
    }
    const sourceSpent = (this.bySource.get(source) ?? 0n) + fee;
    const keySpent = (this.byKey.get(key) ?? 0n) + fee;
    const totalSpent = this.total + fee;
    if (sourceSpent > this.limits.perSource) return "source";
    if (keySpent > this.limits.perKey) return "key";
    if (totalSpent > this.limits.total) return "total";
    this.bySource.set(source, sourceSpent);
    this.byKey.set(key, keySpent);
    this.total = totalSpent;
    return null;
  }
}

export const SPONSORSHIP_BUDGET = Symbol("SPONSORSHIP_BUDGET");
