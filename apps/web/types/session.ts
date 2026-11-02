import type { UnresolvedSubmission } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";

export interface CompletedStepRecord {
  index: number;
  type: string;
  txHash: string;
  confirmedAt: string; // ISO timestamp
}

/** What a refresh keeps of a transaction whose outcome is unknown, enough to look it up. Never the
 *  envelope: a signed transaction is not stored, and a restored session never sends anything. */
export type UnconfirmedRecord = Pick<UnresolvedSubmission, "hash" | "covers" | "validUntil">;

export interface SessionRecord {
  id: string;
  network: Network;
  sourceAddress: string;
  destinationAddress: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  /** Whether the close routes through the shared intermediary. The intermediary's address is
   *  deliberately not stored: verification asserts the hand-off structurally, so nothing needs
   *  to remember which account it was - and a resumed session cannot go stale on a rotation. */
  mediatorRequired: boolean;
  completedSteps: CompletedStepRecord[];
  currentStepIndex: number;
  status: "in_progress" | "completed";
  unconfirmed?: UnconfirmedRecord;
  createdAt: string;
  updatedAt: string;
}
