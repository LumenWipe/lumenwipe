export type StepType =
  | "NORMALIZE_SIGNERS"
  | "REVOKE_SPONSORSHIP"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "ADD_TRUSTLINE_FOR_CLAIM"
  | "CLAIM_BALANCES"
  | "CONVERT_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "CLOSE_ACCOUNT"
  | "MERGE";

export type StepStatus = "pending" | "signing" | "submitted" | "confirmed" | "failed" | "skipped";

/**
 * What happens to a non-XLM balance before its trustline is removed.
 *
 * `convert` swaps it to XLM and `issuer` sends it back to be burned - both end the close with the
 * position destroyed. `transfer` keeps the asset, as the asset, by paying it to another account
 * that already holds the trustline.
 */
export type AssetDisposition = "convert" | "issuer" | "transfer";

/**
 * Where a `transfer` disposition sends its balance, keyed by the same canonical `CODE:ISSUER`
 * string the disposition itself is keyed by.
 *
 * Per asset and arbitrary: the API takes any address here, independently for each asset. Offering
 * "the same account you are merging into" is a UI convenience, not a constraint of the contract -
 * an SDK consumer can send each asset somewhere different.
 *
 * There is deliberately no amount. The `ChangeTrust` that removes the trustline runs immediately
 * after and fails on a non-zero balance, so anything short of the full balance would strand the
 * close midway.
 */
export type TransferDestinations = Record<string, string>;

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
  // Set when no DEX path exists and the user confirms sending to issuer instead
  fallbackToIssuer?: boolean;
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

export interface PlanBlocker {
  message: string;
  helpUrl?: string;
  /** Distinguishes an acknowledged, non-trapping warning (e.g. a chosen forfeit) from a hard
   *  blocker. Absent means the generic hard-blocking case. */
  code?: string;
}

export interface BuildPlanResult {
  steps: PlannedStep[];
  blockers: PlanBlocker[];
}

export interface ConversionPath {
  fromAsset: string;
  toAsset: string;
  path: string[];
  estimatedReceive: string;
  destMin: string;
}
