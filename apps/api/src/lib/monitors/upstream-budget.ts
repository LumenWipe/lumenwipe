/**
 * Month-to-date upstream requests against each provider's monthly request budget, summed from the
 * `upstreamUsage/{date}` documents the API writes (docs/monitoring-plan.md). Budgets are in
 * `config/upstream-budgets.json`, and their sources in docs/runbooks/provider-quotas.mdx.
 */

import { VALID_NETWORKS as NETWORKS, type Network } from "@/config/networks";
import type { Upstream } from "@/lib/stellar/upstream-metrics";

/** The share of a budget that raises a finding. */
export const ALERT_SHARE = 0.7;

export const UPSTREAMS = [
  "rpc",
  "horizon",
  "paths",
  "defi",
  "indexer",
  "soroswap",
  "xbull",
] as const satisfies readonly Upstream[];

/**
 * One quota: the upstreams and networks that spend it, and how many requests a month it allows.
 * A budget of 0 is an upstream never used on that network, so any request to it is a finding.
 */
export interface BudgetEntry {
  provider: string;
  networks: Network[];
  upstreams: Upstream[];
  monthlyRequests: number;
}

/** One `upstreamUsage` day: `counts.<network>.<upstream>.<metric>`. */
export interface UsageDay {
  date: string;
  counts?: Record<string, Record<string, Record<string, number>>>;
}

export interface BudgetUse {
  provider: string;
  networks: Network[];
  upstreams: Upstream[];
  used: number;
  budget: number;
}

/** Every UTC date of `now`'s month up to and including `now`, as `YYYY-MM-DD`. */
export function monthToDate(now: Date): string[] {
  const dates: string[] = [];
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (day.getTime() <= now.getTime()) {
    dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Throws unless every upstream on every network is in exactly one entry, so an upstream added to
 * the API cannot go unbudgeted.
 */
export function parseBudgets(raw: unknown): BudgetEntry[] {
  if (!Array.isArray(raw)) throw new Error("the budgets file must be an array");
  const seen = new Map<string, string>();
  const entries = raw.map((value, i): BudgetEntry => {
    const e = value as Partial<BudgetEntry> | null;
    const where = `budget ${i + 1}`;
    if (!e || typeof e.provider !== "string" || e.provider.trim() === "") {
      throw new Error(`${where} names no provider`);
    }
    if (!Number.isSafeInteger(e.monthlyRequests) || (e.monthlyRequests as number) < 0) {
      throw new Error(`${where} (${e.provider}) needs monthlyRequests as a whole number`);
    }
    const networks = e.networks ?? [];
    const upstreams = e.upstreams ?? [];
    if (networks.length === 0 || upstreams.length === 0) {
      throw new Error(`${where} (${e.provider}) needs networks and upstreams`);
    }
    for (const network of networks) {
      if (!(NETWORKS as readonly string[]).includes(network)) {
        throw new Error(`${where} (${e.provider}) names an unknown network: ${network}`);
      }
      for (const upstream of upstreams) {
        if (!(UPSTREAMS as readonly string[]).includes(upstream)) {
          throw new Error(`${where} (${e.provider}) names an unknown upstream: ${upstream}`);
        }
        const key = `${network}/${upstream}`;
        const other = seen.get(key);
        if (other) throw new Error(`${key} is budgeted twice: ${other} and ${e.provider}`);
        seen.set(key, e.provider);
      }
    }
    return {
      provider: e.provider,
      networks,
      upstreams,
      monthlyRequests: e.monthlyRequests as number,
    };
  });
  for (const network of NETWORKS) {
    for (const upstream of UPSTREAMS) {
      if (!seen.has(`${network}/${upstream}`))
        throw new Error(`${network}/${upstream} has no budget`);
    }
  }
  return entries;
}

/**
 * The requests each entry spent over `days`. A request recorded under the `unknown` network went
 * to one of the networks, so it is charged to every entry holding that upstream: an alert can
 * only come early, never late. Upstreams no entry names (one the API no longer calls) are
 * returned apart, to be logged.
 */
export function budgetUse(
  entries: readonly BudgetEntry[],
  days: readonly UsageDay[]
): { uses: BudgetUse[]; unbudgeted: string[] } {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [network, byUpstream] of Object.entries(day.counts ?? {})) {
      for (const [upstream, metrics] of Object.entries(byUpstream ?? {})) {
        const requests = Number(metrics?.requests ?? 0);
        if (!Number.isFinite(requests) || requests <= 0) continue;
        const key = `${network}/${upstream}`;
        totals.set(key, (totals.get(key) ?? 0) + requests);
      }
    }
  }
  const counted = new Set<string>();
  const uses = entries.map((e) => {
    let used = 0;
    for (const upstream of e.upstreams) {
      for (const network of [...e.networks, "unknown"]) {
        const key = `${network}/${upstream}`;
        used += totals.get(key) ?? 0;
        counted.add(key);
      }
    }
    return {
      provider: e.provider,
      networks: e.networks,
      upstreams: e.upstreams,
      used,
      budget: e.monthlyRequests,
    };
  });
  const unbudgeted = [...totals.keys()].filter((key) => !counted.has(key)).sort();
  return { uses, unbudgeted };
}

export function overBudget(use: Pick<BudgetUse, "used" | "budget">, share = ALERT_SHARE): boolean {
  return use.used > 0 && use.used >= use.budget * share;
}

/** How much of its budget an entry has spent, in whole percent; 100 for any use of a budget of 0. */
export function percentUsed(use: Pick<BudgetUse, "used" | "budget">): number {
  if (use.budget === 0) return use.used > 0 ? 100 : 0;
  return Math.floor((use.used / use.budget) * 100);
}
