import type { PlannedStep, StepType } from "@/types/plan";

/** One real on-chain transaction and the plan steps it carried out. */
export interface TxEntry {
  txHash: string;
  stepTypes: StepType[];
  stepTitles: string[];
}

/**
 * Collapse confirmed steps into the distinct transactions that effected them.
 *
 * A fused fast-path close is a single CLOSE_ACCOUNT step (one entry); a mediator
 * merge adds a second MERGE step (two entries); a stepwise run — and, in future,
 * each Soroban DeFi exit — contributes its own transaction. Steps that share a
 * hash collapse into one entry; steps without a hash are skipped.
 */
export function buildTxLedger(confirmedSteps: PlannedStep[]): TxEntry[] {
  const byHash = new Map<string, TxEntry>();
  const order: string[] = [];

  for (const step of confirmedSteps) {
    if (!step.txHash) continue;
    let entry = byHash.get(step.txHash);
    if (!entry) {
      entry = { txHash: step.txHash, stepTypes: [], stepTitles: [] };
      byHash.set(step.txHash, entry);
      order.push(step.txHash);
    }
    entry.stepTypes.push(step.type);
    entry.stepTitles.push(step.title);
  }

  return order.map((hash) => byHash.get(hash)!);
}
