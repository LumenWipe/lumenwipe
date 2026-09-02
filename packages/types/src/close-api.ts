import type { StepType } from "./plan";
import type { AccountSigner } from "./account";

export type CloseApiStatus = "ready" | "needs_decisions" | "blocked" | "complete";

export interface QuoteInfo {
  estimatedReceive: string;
  path: string[];
  source: "soroswap" | "sdex";
  expiresAtLedger: number;
}

export interface DecisionOption {
  id: string; // e.g. "convert_to_xlm" | "return_to_issuer" | "transfer_to_account" | "acknowledged"
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

// Per-claimable-balance disposition: claim it now, add a trustline first then claim, or give it
// up. "claim" is the opt-out default for a balance the account can already claim (native asset or
// an authorized trustline exists); "add_trustline_then_claim" and "forfeit" only apply to a
// balance the account cannot currently claim.
export type ClaimableBalanceSelection = "claim" | "add_trustline_then_claim" | "forfeit";

export interface DecisionAnswer {
  id: string;
  choice: string;
  params?: {
    maxSlippageBps?: number;
    /**
     * Required by the `transfer_to_account` choice: the `G...` address the balance is paid to.
     *
     * It travels with the answer rather than in a separate map so a destination cannot become
     * detached from the asset it was chosen for - the same reason the unrecognized-destination
     * acknowledgement is keyed by address instead of being a boolean. A `transfer_to_account`
     * answer without a valid destination is a 422; there is no default, because every available
     * fallback would destroy the balance the user asked to keep.
     */
    destination?: string;
  };
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
      // The signer a SetOptions op touches, decoded to its real type/key (not just weight),
      // so verify() can check it against the account's actual signer set. Null when the op
      // only touches thresholds/master weight and carries no signer field.
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
  // A Soroban contract invocation - a DeFi exit. `accountsReferenced` lists every Stellar
  // account address anywhere in the arguments, so a verifier can insist that an exit only ever
  // acts for, and pays, the account being closed - without knowing the protocol's ABI.
  | {
      type: "invoke_host_function";
      contract: string;
      function: string;
      /** The decoded arguments rendered for a human, in order. */
      args: string[];
      /** Every Stellar account (G...) named anywhere in the arguments or in the authorization
       *  tree the signature would satisfy. A verifier insists these are all the closing account. */
      accountsReferenced: string[];
      /** Every contract (C...) named the same way, including nested calls the signature would
       *  authorize. A verifier insists these are contracts the account is known to deal with. */
      contractsReferenced: string[];
      /** Address forms that cannot be pinned to anything (muxed accounts, claimable balances,
       *  liquidity pools). A verifier refuses any. */
      unsupportedAddressCount: number;
      /** True when the signature would authorize more than the account's own plain contract
       *  calls: another party's credentials, or a contract creation, in the auth entries. */
      authorizesBeyondSelf: boolean;
    }
  // Any operation the close vocabulary does not recognize, preserved rather than dropped so
  // verification can reject an effect it cannot describe.
  | { type: "unknown" };

export interface TxIntent {
  summary: string;
  source: string;
  fee: string;
  memo: string | null;
  /** The memo's type, so a check can assert it matches what the destination requires rather
   *  than only that some memo is present. */
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
  /**
   * `requiresAnotherCall` is true when more transactions follow the returned batch:
   * submit these, wait for confirmation, then request transactions again. `steps` is the
   * approximate number of build rounds still remaining.
   */
  remaining: { steps: number; requiresAnotherCall: boolean };
}
