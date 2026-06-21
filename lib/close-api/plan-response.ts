import { createHash } from "node:crypto";
import type { BuildPlanResult, PlannedStep } from "@/types/plan";
import type {
  CloseApiStatus,
  DecisionAnswer,
  DecisionPoint,
  ExecutionTxBreakdown,
  PlanResponse,
} from "@/types/close-api";

// Hash of everything that determines a plan: the source, destination, the resolved
// decisions, and the snapshot ledger. Decisions are sorted so ordering does not change
// the hash. The client passes this back to /transactions so a materially changed account
// is detected (409 state_changed) before signing a plan it never reviewed.
export function computePlanHash(input: {
  source: string;
  destination: string | null;
  decisions: DecisionAnswer[];
  snapshotLedger: number;
}): string {
  const canonical = JSON.stringify({
    source: input.source,
    destination: input.destination,
    decisions: [...input.decisions].sort((a, b) => a.id.localeCompare(b.id)),
    snapshotLedger: input.snapshotLedger,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// Phase 1 has no cross-transaction data dependencies, so the whole ordered plan is a
// single fused transaction. The DeFi `frontier` path (multiple transactions) is a
// follow-up; when it lands this function splits at dependency boundaries.
export function toExecutionBreakdown(steps: PlannedStep[]): {
  estimatedTransactionCount: number;
  transactions: ExecutionTxBreakdown[];
} {
  if (steps.length === 0) return { estimatedTransactionCount: 0, transactions: [] };
  return {
    estimatedTransactionCount: 1,
    transactions: [{ order: 0, covers: [...new Set(steps.map((s) => s.type))] }],
  };
}

function deriveStatus(buildResult: BuildPlanResult, decisionPoints: DecisionPoint[]): CloseApiStatus {
  if (buildResult.blockers.length > 0) return "blocked";
  if (buildResult.steps.length === 0) return "complete";
  if (decisionPoints.length > 0) return "needs_decisions";
  return "ready";
}

export function assemblePlanResponse(args: {
  buildResult: BuildPlanResult;
  decisionPoints: DecisionPoint[];
  planHash: string;
  estimate: { feeStroops: string; freedReserveXlm: string };
}): PlanResponse {
  const { buildResult, decisionPoints, planHash, estimate } = args;
  return {
    planHash,
    status: deriveStatus(buildResult, decisionPoints),
    steps: buildResult.steps,
    decisionPoints,
    // PlanBlocker carries no stable code yet; emit a generic one until buildPlan is
    // enriched with per-blocker codes (e.g. exchange_destination_missing_memo).
    blockers: buildResult.blockers.map((b) => ({
      code: "plan_blocker",
      message: b.message,
      helpUrl: b.helpUrl,
    })),
    estimate,
    execution: toExecutionBreakdown(buildResult.steps),
  };
}
