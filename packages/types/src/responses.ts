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

/**
 * One transaction in a `GET /v1/:network/close/delivered` answer. `delivered` means the ledger's
 * own result for the confirmed transaction credited `amountStroops` of XLM to the destination,
 * through a merge into it or, for a close routed through the relay account, the native payment
 * that forwarded the merged balance. `unavailable` never carries an amount:
 * - `not_found`: no provider holds the hash. It may be unknown, still pending, or older than the
 *   providers keep.
 * - `failed`: the transaction failed, so it moved nothing.
 * - `no_delivery`: it confirmed, but no merge into the destination and no forward of a merged
 *   balance to it is in it.
 */
export type CloseDeliveredEntry =
  | { hash: string; status: "delivered"; ledger: number; amountStroops: string }
  | {
      hash: string;
      status: "unavailable";
      reason: "not_found" | "failed" | "no_delivery";
      /** Set when the transaction is on the ledger: failed or no_delivery. */
      ledger?: number;
    };

/**
 * Response from `GET /v1/:network/close/delivered`. `entries` follow the order of the requested
 * hashes. `totalStroops` is present only when every entry is `delivered`. XLM that reached the
 * destination by any other operation, and any asset other than XLM, is not counted.
 */
export interface CloseDeliveredResponse {
  destination: string;
  entries: CloseDeliveredEntry[];
  totalStroops?: string;
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
