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

/**
 * Response from `GET /v1/:network/transactions/:hash`. `not_found` names the ledger window one RPC
 * provider searched: the transaction may still be queued, or be older than that window. Close times
 * are unix seconds.
 */
export type TransactionLookupResponse =
  | { status: "confirmed"; hash: string; ledger: number }
  | { status: "failed"; hash: string; ledger: number; message: string; resultCode?: string }
  | {
      status: "not_found";
      hash: string;
      searched: {
        oldestLedger: number;
        oldestLedgerCloseTime: number;
        latestLedger: number;
        latestLedgerCloseTime: number;
      };
    };

/** Sub-entries and sponsorships the ledger still counts on an account. */
export interface CloseStatusRemaining {
  subentries: number;
  sponsoring: number;
  sponsored: number;
}

/**
 * Response from `GET /v1/:network/close/status`. Informational: `closed` means the account is
 * absent and the last operation in its history is a merge, never that a given close finished.
 */
export interface CloseStatusResponse {
  source: string;
  phase: "open" | "ready_to_merge" | "closed" | "unknown";
  /** Present while the account is on the ledger. */
  remaining?: CloseStatusRemaining;
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
