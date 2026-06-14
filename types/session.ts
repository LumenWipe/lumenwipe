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
  mediatorPublicKey: string | null;
  completedSteps: CompletedStepRecord[];
  currentStepIndex: number;
  status: "in_progress" | "completed";
  createdAt: string;
  updatedAt: string;
}
