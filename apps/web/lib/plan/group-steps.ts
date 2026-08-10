import type { PlannedStep, StepType } from "@/types/plan";

export interface StepGroup {
  type: StepType;
  label: string;
  steps: PlannedStep[];
}

export const STEP_GROUP_LABELS: Record<StepType, string> = {
  NORMALIZE_SIGNERS: "Remove signers",
  REVOKE_SPONSORSHIP: "Revoke sponsorships",
  REMOVE_DATA_ENTRIES: "Remove data",
  CANCEL_OFFERS: "Cancel offers",
  ADD_TRUSTLINE_FOR_CLAIM: "Add trustlines to claim",
  CLAIM_BALANCES: "Claim balances",
  CONVERT_ASSETS: "Handle assets",
  REMOVE_TRUSTLINES: "Remove trustlines",
  CLOSE_ACCOUNT: "Close account",
  MERGE: "Merge account",
};

/**
 * Groups the finalized plan by step type, preserving first-occurrence order. A single type can
 * span multiple batched steps (e.g. two REVOKE_SPONSORSHIP batches) - those collapse into one
 * group rather than rendering as separate, identically-labeled sections.
 */
export function groupStepsByType(steps: PlannedStep[]): StepGroup[] {
  const order: StepType[] = [];
  const byType = new Map<StepType, PlannedStep[]>();
  for (const s of steps) {
    if (!byType.has(s.type)) {
      byType.set(s.type, []);
      order.push(s.type);
    }
    byType.get(s.type)!.push(s);
  }
  return order.map((type) => ({ type, label: STEP_GROUP_LABELS[type], steps: byType.get(type)! }));
}
