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

interface DaySpend {
  total: bigint;
  bySource: Map<string, bigint>;
  byKey: Map<string, bigint>;
  innerHashes: Set<string>;
}

/**
 * Fees the sponsor has signed for in the current UTC day, kept apart per network because each
 * network has its own fee account. A fee counts when it is signed, not when it lands: the
 * signature is what can be spent. The same inner transaction signed again is not counted twice,
 * since only one of its envelopes can ever land.
 *
 * In-process, like the request throttler: the API runs as one instance, and a restart grants a
 * fresh day's budget, which the per-transaction cap and the fee account's small float bound.
 */
export class SponsorshipBudget {
  private day = "";
  private readonly byNetwork = new Map<string, DaySpend>();

  constructor(private readonly limits: SponsorshipBudgetLimits = DEFAULT_SPONSORSHIP_LIMITS) {}

  reserve(
    spend: { network: string; source: string; key: string; innerHash: string; fee: bigint },
    now: Date
  ): BudgetScope | null {
    const today = now.toISOString().slice(0, 10);
    if (today > this.day) {
      this.day = today;
      this.byNetwork.clear();
    }
    const day = this.spendFor(spend.network);
    if (day.innerHashes.has(spend.innerHash)) return null;
    const sourceSpent = (day.bySource.get(spend.source) ?? 0n) + spend.fee;
    const keySpent = (day.byKey.get(spend.key) ?? 0n) + spend.fee;
    const totalSpent = day.total + spend.fee;
    if (sourceSpent > this.limits.perSource) return "source";
    if (keySpent > this.limits.perKey) return "key";
    if (totalSpent > this.limits.total) return "total";
    day.bySource.set(spend.source, sourceSpent);
    day.byKey.set(spend.key, keySpent);
    day.total = totalSpent;
    day.innerHashes.add(spend.innerHash);
    return null;
  }

  private spendFor(network: string): DaySpend {
    let day = this.byNetwork.get(network);
    if (!day) {
      day = { total: 0n, bySource: new Map(), byKey: new Map(), innerHashes: new Set() };
      this.byNetwork.set(network, day);
    }
    return day;
  }
}

export const SPONSORSHIP_BUDGET = Symbol("SPONSORSHIP_BUDGET");
