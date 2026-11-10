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

/** Response from `GET /v1/:network/paths`. */
export interface PathResponse {
  path: ConversionPath | null;
}

/** Response from `POST /v1/:network/mediator/sign`. */
export interface MediatorSignResponse {
  transaction: string;
}

/** Response from `POST /v1/:network/fee-bump/sponsor`. */
export interface FeeBumpSponsorResponse {
  transaction: string;
}

/** Response from `POST /v1/:network/allowances/revoke`. */
export interface RevokeAllowanceResponse {
  transaction: string;
}

/** Response from `GET /health`. */
export interface HealthResponse {
  status: string;
}

/** One indicator of `GET /health/deep`: `rpc_<network>` carries `responseTime` in ms (and a fixed
 *  `message`, `"timeout"` or `"unreachable"`, when down); `exchange_registry` carries
 *  `daysRemaining`, negative once the registry has expired. */
export interface HealthDeepIndicator {
  status: "up" | "down";
  responseTime?: number;
  message?: string;
  daysRemaining?: number;
}

/**
 * Body of `GET /health/deep`. It answers 200 with `status: "ok"` when Stellar RPC is reachable on
 * every network, and 503 with this same shape and `status: "error"` when it is not: the indicators
 * that failed are in `error`, the rest in `info`, and every one of them in `details`.
 */
export interface HealthDeepResponse {
  status: "ok" | "error";
  info: Record<string, HealthDeepIndicator>;
  error: Record<string, HealthDeepIndicator>;
  details: Record<string, HealthDeepIndicator>;
}

/** One exchange in the registry: whether a close into it needs the mediator, and its memo rule. */
export interface ExchangeRegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  /** The required memo type, if `requiresMemo` is true. */
  memoType: "text" | "id" | "hash";
  /** Present only on an entry scoped to testnet. Absent means the entry applies on every network. */
  network?: "testnet";
}

/**
 * Response from `GET /v1/config/exchange-registry`. A consumer must refuse to rely on it past
 * `validUntil` (YYYY-MM-DD): a close into an exchange with the wrong memo rule succeeds on-chain and
 * is credited to nobody.
 */
export interface ServedExchangeRegistry {
  version: string;
  /** The date every entry was last checked against the exchanges' own deposit docs. */
  lastVerified: string;
  /** After this date the data is treated as unusable, not merely old. */
  validUntil: string;
  source: string;
  entries: ExchangeRegistryEntry[];
}
