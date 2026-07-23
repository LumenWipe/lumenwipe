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
}

/** Body for `POST /v1/:network/submit`. */
export interface SubmitRequest {
  signedXdr: string;
}
