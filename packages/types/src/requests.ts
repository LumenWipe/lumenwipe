import type { DecisionAnswer } from "./close-api";

/** Body for `POST /v1/:network/close/plan`. */
export interface ClosePlanRequest {
  source: string;
  destination?: string;
  decisions?: DecisionAnswer[];
}

/** Body for `POST /v1/:network/close/batch-plan`: up to 20 accounts planned into one shared
 *  destination, read-only, with no decisions applied. */
export interface BatchPlanRequest {
  addresses: string[];
  destination?: string;
}

/** Body for `POST /v1/:network/close/transactions`. */
export interface CloseTransactionsRequest {
  source: string;
  destination: string;
  decisions?: DecisionAnswer[];
  /**
   * Deposit memo value. Required when the destination is an exchange that mandates a
   * memo, or an account whose `config.memo_required` data entry is set (SEP-29). A blank
   * memo counts as none. An id memo is a decimal uint64 with no leading zeros.
   */
  memo?: string;
  /**
   * The type of `memo`. For an exchange the registry lists, the registry's type is used and
   * a different one is refused with `422 invalid_memo`; for any other destination this type
   * is used, `text` when omitted. Has no effect without a memo.
   */
  memoType?: "text" | "id";
  /**
   * The `planHash` of the plan the user reviewed. Send it with the first call after that plan, and
   * the API answers `409 state_changed` when the account's sequence or the answers differ from
   * those the plan was built from. Leave it out once a transaction of the close has confirmed: the
   * account has then changed on purpose.
   */
  planHash?: string;
}

/** Body for `POST /v1/:network/submit`. */
export interface SubmitRequest {
  signedXdr: string;
}

/** Body for `POST /v1/:network/stats/merges`. */
export interface RecordMergeRequest {
  txHash: string;
}
