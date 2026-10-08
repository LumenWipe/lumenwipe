import type { Network } from "./network";

/** Response from `GET /v1/:network/stats`. Stroops are decimal strings: the total can exceed 2^53. */
export interface StatsTotals {
  network: Network;
  accountsClosed: number;
  xlmRecoveredStroops: string;
}

/** One verified, counted close transaction. */
export interface MergeRecord {
  txHash: string;
  network: Network;
  accountsClosed: number;
  xlmStroops: string;
  /** Ledger close time of the transaction, ISO 8601. */
  timestamp: string;
}

export interface DailyActivity {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  accountsClosed: number;
}

/** Response from `GET /v1/:network/stats/feed`. `daily` is oldest first, one entry per day. */
export interface StatsFeed {
  totals: StatsTotals;
  recent: MergeRecord[];
  daily: DailyActivity[];
}

/** Response from `POST /v1/:network/stats/merges`. `counted` is false for an already-counted hash. */
export interface RecordMergeResponse {
  counted: boolean;
}
