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
   * Deposit memo value for exchange destinations that require one. The memo type
   * is taken from the exchange registry, not the client. Required when the
   * destination is an exchange that mandates a memo.
   */
  memo?: string;
}

/** Body for `POST /v1/:network/submit`. */
export interface SubmitRequest {
  signedXdr: string;
}
