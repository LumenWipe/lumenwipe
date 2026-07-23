import type { Network } from "@/config/networks";

export interface MergeHistoryEntry {
  id: string;
  network: Network;
  sourceAddress: string;
  destinationAddress: string;
  completedAt: string;
  txReceipts: { type: string; title: string; txHash: string }[];
  totalFeeLumens: string;
  usedMediator: boolean;
}
