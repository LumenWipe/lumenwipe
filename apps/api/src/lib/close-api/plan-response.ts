import { createHash } from "node:crypto";
import type {
  BuildPlanResult,
  CloseApiStatus,
  DecisionAnswer,
  DecisionPoint,
  ExecutionTxBreakdown,
  PlanResponse,
  PlannedStep,
  StepType,
} from "@lumenwipe/types";
import { isTokenContract } from "@/lib/close-api/decisions";
import { splitCloseOps } from "@/lib/stellar/tx-builder/close-operations";

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

export interface ExecutionBreakdownInput {
  /** The destination is an exchange that is paid through the mediator, one more transaction. */
  viaMediator: boolean;
  /** False when a fact the count depends on is not settled yet: no destination, or a held token
   *  the caller has not decided about. */
  decided: boolean;
}

const CLAIM_STEPS: ReadonlySet<StepType> = new Set(["ADD_TRUSTLINE_FOR_CLAIM", "CLAIM_BALANCES"]);

function expandOps(steps: PlannedStep[]): StepType[] {
  return steps.flatMap((s) => Array.from({ length: s.operationCount }, () => s.type));
}

function splitGroup(ops: StepType[]): ExecutionTxBreakdown[] {
  return splitCloseOps(ops).map((chunk, i) => ({
    order: 0,
    covers: [...new Set(chunk)],
    ...(i > 0 ? { reason: "op_batch" as const } : {}),
  }));
}

/**
 * The transactions the close will take, in the order `buildCloseTransactions` produces them
 * across its rounds: each Soroban token move on its own, the claim round, the classic close
 * split by the same `splitCloseOps` the builder packs with, and the mediator transaction last.
 *
 * A DeFi exit takes as many transactions as its live debt and simulation need, so a plan with one
 * has no knowable count; the same goes for an undecided input. Those report `null` instead of a
 * number that would be wrong.
 */
export function toExecutionBreakdown(
  steps: PlannedStep[],
  { viaMediator, decided }: ExecutionBreakdownInput
): PlanResponse["execution"] {
  if (steps.length === 0) return { estimatedTransactionCount: 0, transactions: [] };
  if (!decided || steps.some((s) => s.type === "EXIT_POSITIONS" || s.type === "CLOSE_ACCOUNT")) {
    return { estimatedTransactionCount: null, transactions: [] };
  }
  const isToken = (s: PlannedStep): boolean =>
    s.type === "HANDLE_ASSETS" && s.affectedAsset !== undefined && isTokenContract(s.affectedAsset);

  const tokenMoves = steps
    .filter((s) => isToken(s) && s.operationCount > 0)
    .map((): ExecutionTxBreakdown => ({ order: 0, covers: ["HANDLE_ASSETS"] }));
  const claims = splitGroup(expandOps(steps.filter((s) => CLAIM_STEPS.has(s.type))));
  const close = splitGroup(
    expandOps(
      steps.filter(
        (s) => !isToken(s) && !CLAIM_STEPS.has(s.type) && (s.type !== "MERGE" || !viaMediator)
      )
    )
  );
  const mediator: ExecutionTxBreakdown[] = viaMediator ? [{ order: 0, covers: ["MERGE"] }] : [];

  const transactions = [...tokenMoves, ...claims, ...close, ...mediator].map((t, order) => ({
    ...t,
    order,
  }));
  return { estimatedTransactionCount: transactions.length, transactions };
}

function deriveStatus(
  buildResult: BuildPlanResult,
  decisionPoints: DecisionPoint[]
): CloseApiStatus {
  if (buildResult.blockers.length > 0) return "blocked";
  if (buildResult.steps.length === 0) return "complete";
  if (decisionPoints.length > 0) return "needs_decisions";
  return "ready";
}

export function assemblePlanResponse(args: {
  buildResult: BuildPlanResult;
  decisionPoints: DecisionPoint[];
  /** The subset still unanswered. Drives the status alone: the response carries every decision
   *  point, answered or not, because the caller renders from this list and knows its own
   *  answers. Returning only the pending ones made each card vanish the moment it was answered
   *  - and a re-analyze that remembered its answers rendered no cards at all. */
  pendingDecisionPoints?: DecisionPoint[];
  planHash: string;
  estimate: { feeStroops: string; freedReserveXlm: string };
  execution: ExecutionBreakdownInput;
}): PlanResponse {
  const { buildResult, decisionPoints, planHash, estimate } = args;
  const pending = args.pendingDecisionPoints ?? decisionPoints;
  return {
    planHash,
    status: deriveStatus(buildResult, pending),
    steps: buildResult.steps,
    decisionPoints,
    // Most blockers still carry no stable code; fall back to a generic one for those
    // (e.g. exchange_destination_missing_memo is still TODO). buildPlan sets a specific
    // code for the ones a client needs to distinguish, e.g. a forfeited claimable balance
    // must not read as a hard blocker once the caller already made that choice.
    blockers: buildResult.blockers.map((b) => ({
      code: b.code ?? "plan_blocker",
      message: b.message,
      helpUrl: b.helpUrl,
    })),
    estimate,
    execution: toExecutionBreakdown(buildResult.steps, args.execution),
  };
}
