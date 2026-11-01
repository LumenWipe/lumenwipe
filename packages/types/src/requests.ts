import type { DecisionAnswer } from "./close-api";

/** Body for `POST /v1/:network/close/plan`. */
export interface ClosePlanRequest {
  source: string;
  destination?: string;
  decisions?: DecisionAnswer[];
}

/** Body for `POST /v1/:network/close/transactions`. */
export interface CloseTransactionsRequest {
  source: string;
  destination: string;
  decisions?: DecisionAnswer[];
  /**
   * Deposit memo value. The memo type is taken from the exchange registry, not the
   * client, and is text for an unlisted destination. Required when the destination
   * is an exchange that mandates a memo, or an account whose `config.memo_required`
   * data entry is set (SEP-29). A blank memo counts as none.
   */
  memo?: string;
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
