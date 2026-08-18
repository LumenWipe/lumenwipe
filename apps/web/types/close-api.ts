import type { StepType } from "@/types/plan";
import type { AccountSigner } from "@/types/account";

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

/**
 * One operation in a decoded close transaction.
 *
 * `source` is the account the operation acts as - the operation's own source account when it
 * carries one, otherwise the transaction's. It is what lets verification assert relationships
 * *between* operations rather than trusting each in isolation: in a mediated close the forward
 * payment must be sent by the very account the merge just paid into, which is what makes the
 * intermediary a conduit rather than a destination. Without it the only available check is
 * pinning the intermediary's address, which every consumer would then have to be told.
 */
export type IntentOperation = IntentOperationBody & { source: string };

export type IntentOperationBody =
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
      // The signer a SetOptions op touches, decoded to its real type/key (not just weight), so
      // verify() can check it against the account's actual signer set. Null when the op only
      // touches thresholds/master weight and carries no signer field.
      signer: AccountSigner | null;
      masterWeight: number | null;
      lowThreshold: number | null;
      medThreshold: number | null;
      highThreshold: number | null;
      // The close flow's own normalization step never legitimately sets these - carried
      // through so verify() can reject a SetOptions that touches them instead of silently
      // dropping the field during decode (see issue #103 for the gap this closes).
      homeDomain: string | null;
      setFlags: number | null;
      clearFlags: number | null;
      inflationDest: string | null;
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
