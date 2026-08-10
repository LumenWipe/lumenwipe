import type { StepType } from "@/types/plan";

export type CloseApiStatus = "ready" | "needs_decisions" | "blocked" | "complete";

export interface QuoteInfo {
  estimatedReceive: string;
  path: string[];
  source: "soroswap" | "sdex";
  expiresAtLedger: number;
}

export interface DecisionOption {
  id: string; // e.g. "convert_to_xlm" | "return_to_issuer" | "acknowledged"
  recommended?: boolean;
  quote?: QuoteInfo;
  note?: string; // English only
}

export interface DecisionPoint {
  id: string; // stable, e.g. "asset:USDC-GISSUER..."
  type: "asset_disposition" | "confirmation" | "choice" | "claimable_balance";
  subject: Record<string, unknown>;
  options: DecisionOption[];
  default: string;
  required: boolean;
}

export interface DecisionAnswer {
  id: string;
  choice: string;
  params?: { maxSlippageBps?: number };
}

export interface ExecutionTxBreakdown {
  order: number;
  covers: StepType[];
  reason?: "op_batch" | "defi_dependency";
}

export interface PlanResponse {
  planHash: string;
  status: CloseApiStatus;
  steps: unknown[]; // PlannedStep[] serialized; reuse types/plan PlannedStep
  decisionPoints: DecisionPoint[];
  blockers: { code: string; message: string; helpUrl?: string }[];
  estimate: { feeStroops: string; freedReserveXlm: string };
  execution: { estimatedTransactionCount: number; transactions: ExecutionTxBreakdown[] };
}

export type IntentOperation =
  | {
      type: "path_payment_strict_send";
      sendAsset: string;
      sendAmount: string;
      destination: string;
      destAsset: string;
      destMin: string;
      path: string[];
    }
  | { type: "payment"; destination: string; asset: string; amount: string }
  | { type: "change_trust"; asset: string; limit: string }
  | { type: "account_merge"; destination: string }
  | { type: "manage_sell_offer"; offerId: string; amount: string }
  | { type: "manage_data"; name: string; value: string | null }
  | {
      type: "set_options";
      // Captured so verify() can reject an injected/empowered signer or a disabled master key.
      signerWeight: number | null;
      masterWeight: number | null;
      lowThreshold: number | null;
      medThreshold: number | null;
      highThreshold: number | null;
    }
  | { type: "claim_claimable_balance"; balanceId: string }
  | {
      type: "revoke_sponsorship";
      entryKind: "account" | "trustline" | "offer" | "data_entry" | "signer";
      owner: string;
    }
  | { type: "unknown" };

export interface TxIntent {
  summary: string;
  source: string;
  fee: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  guarantees: {
    mergeDestination: string | null;
    paymentsOnlyTo: string[];
    minXlmFromConversions: string | null;
  };
  operations: IntentOperation[];
}

export interface CloseTransaction {
  id: string;
  order: number;
  dependsOn: string[];
  xdr: string;
  networkPassphrase: string;
  sourceSequence: string;
  validUntilLedger: number;
  covers: StepType[];
  intent: TxIntent;
}

export interface TransactionsResponse {
  planHash: string;
  status: CloseApiStatus;
  transactions: CloseTransaction[];
  remaining: { steps: number; requiresAnotherCall: boolean };
}
