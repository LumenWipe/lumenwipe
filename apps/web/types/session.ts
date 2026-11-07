import type { UnresolvedSubmission } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";

/** The shape of the saved close and receipt records. A record without one predates the field and
 *  is read with defaults for whatever it lacks. */
export const RECORD_VERSION = 2;

/** One confirmed transaction of the close, in the order it was confirmed. */
export interface CompletedStepRecord {
  index: number;
  /** The step the transaction was for: the merge when it carries one. */
  type: string;
  txHash: string;
  confirmedAt: string; // ISO timestamp
}

/** What a refresh keeps of a transaction whose outcome is unknown, enough to look it up. Never the
 *  envelope: a signed transaction is not stored, and a restored session never sends anything. */
export type UnconfirmedRecord = Pick<UnresolvedSubmission, "hash" | "covers" | "validUntil">;

export interface SessionRecord {
  version: number;
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
  /** Plan steps of the close confirmed so far, counted across every plan it was reviewed with. */
  currentStepIndex: number;
  /** The steps of the close as this browser planned it: those confirmed before the last review
   *  confirm plus that plan's steps. Null for a record that predates the count. */
  stepCount: number | null;
  /** Steps confirmed before the plan last confirmed on review, which counts its own from zero. */
  stepBase: number;
  status: "in_progress" | "completed";
  unconfirmed?: UnconfirmedRecord;
  createdAt: string;
  updatedAt: string;
}
