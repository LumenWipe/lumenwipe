import type { Network } from "@/config/networks";

export interface CompletedStepRecord {
  index: number;
  type: string;
  txHash: string;
  confirmedAt: string; // ISO timestamp
}

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
  createdAt: string;
  updatedAt: string;
}
