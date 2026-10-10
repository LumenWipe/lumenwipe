import type { Network } from "@/config/networks";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { mapDomainError, PLAN_ERRORS } from "@/lib/close-api/domain-errors";
import type { BatchPlanResult, PlanResponse } from "@lumenwipe/types";

/**
 * Reading N accounts against RPC/Horizon isn't free: a single plan already enumerates
 * sponsorship (up to `SPONSORSHIP_MAX_OPERATIONS_SCANNED` operations), prices every held asset
 * against the DEX, and races two swap-quote providers per Soroban token. Kept well under what a
 * fleet operator would need in one call so a batch stays a bounded, predictable cost rather than
 * an open-ended fan-out.
 */
export const BATCH_PLAN_MAX_ADDRESSES = 20;

/** How many addresses in a batch are planned concurrently, bounding the upstream fan-out. */
const BATCH_PLAN_CONCURRENCY = 5;

export interface BatchPlanDeps {
  buildAccountPlan: typeof buildAccountPlan;
}

export const defaultBatchPlanDeps = (): BatchPlanDeps => ({ buildAccountPlan });

const BLOCKED_ESTIMATE = { feeStroops: "0", freedReserveXlm: "0.0000000" } as const;

/**
 * Maps through the same table `CloseController.plan()` answers from, so a batch result and a
 * single `close/plan` failure are always the same vocabulary. Anything unrecognized falls back to
 * `plan_failed`, mirroring that endpoint's own catch-all.
 */
function blockedPlanFor(address: string, error: unknown): PlanResponse {
  const mapped = mapDomainError(PLAN_ERRORS, error);
  const blocker = mapped
    ? { code: mapped.code, message: mapped.message }
    : { code: "plan_failed" as const, message: `Failed to build the close plan for ${address}.` };
  return {
    planHash: "",
    status: "blocked",
    steps: [],
    decisionPoints: [],
    blockers: [blocker],
    estimate: BLOCKED_ESTIMATE,
    execution: { estimatedTransactionCount: 0, transactions: [] },
  };
}

/**
 * Plans every address independently, bounded by `BATCH_PLAN_CONCURRENCY`. An address that
 * cannot be read or planned safely never fails the others - its result carries a `blocked`
 * plan with the failure as that address's own blocker (issue #288).
 */
export async function planBatch(
  addresses: string[],
  destination: string | null,
  network: Network,
  deps: BatchPlanDeps = defaultBatchPlanDeps()
): Promise<BatchPlanResult[]> {
  const results = new Array<BatchPlanResult>(addresses.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= addresses.length) return;
      const address = addresses[index]!;
      try {
        const plan = await deps.buildAccountPlan(address, destination, [], network);
        results[index] = { address, plan };
      } catch (error) {
        results[index] = { address, plan: blockedPlanFor(address, error) };
      }
    }
  }

  const workerCount = Math.min(BATCH_PLAN_CONCURRENCY, addresses.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
