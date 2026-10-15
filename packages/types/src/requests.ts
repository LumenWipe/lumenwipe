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
}

/** Body for `POST /v1/:network/submit`. */
export interface SubmitRequest {
  signedXdr: string;
}
