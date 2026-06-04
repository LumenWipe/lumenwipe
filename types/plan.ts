export type StepType =
  | "NORMALIZE_SIGNERS"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "CLAIM_BALANCES"
  | "CONVERT_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "MERGE";

export type StepStatus = "pending" | "signing" | "submitted" | "confirmed" | "failed" | "skipped";

export interface PlannedStep {
  index: number;
  type: StepType;
  title: string;
  description: string;
  operationCount: number;
  estimatedFeeLumens: string;
  // Populated lazily at execution time
  txXdr: string | null;
  status: StepStatus;
  txHash: string | null;
  error: string | null;
  // Metadata for display
  affectedAsset?: string; // for CONVERT_ASSETS steps
}

export type DemolishPhase =
  | "IDLE"
  | "ANALYZING"
  | "PREFLIGHT_COMPLETE"
  | "SIGNER_SETUP"
  | "STEP_EXECUTING"
  | "STEP_CONFIRMED"
  | "STEP_FAILED"
  | "COMPLETE"
  | "ABORTED";

export interface ConversionPath {
  fromAsset: string;
  toAsset: string;
  path: string[];
  estimatedReceive: string;
  destMin: string;
}
