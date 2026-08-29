import type { PlannedStep, StepType } from "@/types/plan";
import { STEP_GROUP_LABELS } from "@/lib/plan/group-steps";

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
 * merge adds a second MERGE step (two entries); a stepwise run - and, in future,
 * each Soroban DeFi exit - contributes its own transaction. Steps that share a
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

/**
 * One line naming what a transaction did, for the ledger row.
 *
 * The phases it carried out, not its steps' titles. Joining the titles put a recap of the
 * "what was done" groups - which sit directly above this row - into a single truncating line,
 * and the per-asset dispositions made it unreadable ("Return BURN to issuer + Send KEEP to
 * GAWIWBZJ…TSY2VKTZ + Convert US…"). The row exists to identify a transaction and link it, so
 * it borrows the group vocabulary the reader has already seen rather than restating the detail.
 *
 * Deduped by type in first-occurrence order: a phase split across batches is still one phase.
 */
export function labelForTx(entry: TxEntry): string {
  const seen = new Set<StepType>();
  const phases: string[] = [];
  for (const type of entry.stepTypes) {
    if (seen.has(type)) continue;
    seen.add(type);
    phases.push(STEP_GROUP_LABELS[type]);
  }
  return phases.join(" · ");
}
