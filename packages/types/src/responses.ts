import type { ConversionPath } from "./plan";

/** Response from `POST /v1/:network/submit`. */
export interface SubmitResponse {
  status: "success";
  hash: string;
  ledger: number;
}

/**
 * `error.details` of a `confirmation_timeout` from `POST /v1/:network/submit`. It is an error, not
 * a 2xx, because a client that reads `hash` from a success would count the transaction confirmed.
 * Compute the hash from the envelope you signed rather than taking this one on trust.
 */
export interface SubmitPendingDetails {
  status: "pending";
  hash: string;
}

/** Response from `GET /:network/paths`. */
export interface PathResponse {
  path: ConversionPath | null;
}

/** Response from `POST /:network/mediator/sign`. */
export interface MediatorSignResponse {
  transaction: string;
}

/** Response from `POST /:network/fee-bump/sponsor`. */
export interface FeeBumpSponsorResponse {
  transaction: string;
}

/** Response from `POST /:network/allowances/revoke`. */
export interface RevokeAllowanceResponse {
  transaction: string;
}

/** Response from `GET /health`. */
export interface HealthResponse {
  status: string;
}
