import type { ErrorCode } from "@lumenwipe/types";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import {
  AccountNotFoundError,
  AssetRouteLostError,
  UnusableProviderResponseError,
} from "@/lib/utils/errors";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { DestinationReadError, LedgerReadError } from "@/lib/close-api/merge-preflight";
import {
  decisionIdFor,
  MissingConversionFloorError,
  MissingTransferDestinationError,
  tokenDecisionId,
  UnrecognizedConversionProviderError,
} from "@/lib/close-api/decisions";

export interface MappedError {
  code: ErrorCode;
  status: number;
  message: string;
  details?: unknown;
}

export interface DomainErrorEntry {
  type: new (...args: never[]) => Error;
  map: (error: unknown) => MappedError | null;
}

function entry<E extends Error>(
  type: new (...args: never[]) => E,
  map: (error: E) => MappedError
): DomainErrorEntry {
  return { type, map: (error) => (error instanceof type ? map(error) : null) };
}

const ACCOUNT_NOT_FOUND = entry(AccountNotFoundError, (e) => ({
  code: "account_not_found",
  status: 404,
  message: e.message,
}));

/** A property of the account, with a message that explains it - not a server fault. */
const ACCOUNT_TOO_LARGE = entry(TruncatedCollectionError, (e) => ({
  code: "account_too_large",
  status: 422,
  message: e.message,
}));

/** A misconfigured provider, upstream of us rather than a fault in the request. */
const PROVIDER_UNUSABLE = entry(UnusableProviderResponseError, (e) => ({
  code: "provider_response_unusable",
  status: 502,
  message: e.message,
}));

/** A failed read, not an answer: retrying may succeed, so it must never read as "missing". */
const DESTINATION_READ_FAILED = entry(DestinationReadError, (e) => ({
  code: "destination_read_failed",
  status: 503,
  message: e.message,
}));

const LEDGER_READ_FAILED = entry(LedgerReadError, (e) => ({
  code: "service_unavailable",
  status: 503,
  message: e.message,
}));

const LIVE_READ_FAILED = entry(LiveReadError, (e) => ({
  code: "service_unavailable",
  status: 503,
  message: e.message,
}));

/** What `close/plan` and each `close/batch-plan` address recognise as a planning failure. */
export const PLAN_ERRORS: readonly DomainErrorEntry[] = [
  ACCOUNT_NOT_FOUND,
  ACCOUNT_TOO_LARGE,
  PROVIDER_UNUSABLE,
  DESTINATION_READ_FAILED,
  LEDGER_READ_FAILED,
];

/** What `close/transactions` recognises; anything else is a `transactions_failed`. */
export const TRANSACTION_ERRORS: readonly DomainErrorEntry[] = [
  ACCOUNT_NOT_FOUND,
  DESTINATION_READ_FAILED,
  LEDGER_READ_FAILED,
  LIVE_READ_FAILED,
  entry(AssetRouteLostError, () => ({
    code: "quote_drifted",
    status: 409,
    message: "A conversion route is no longer available; re-plan and retry.",
  })),
  entry(MissingTransferDestinationError, (e) => ({
    code: "transfer_destination_missing",
    status: 422,
    message: e.message,
    details: { decisionId: decisionIdFor(e.asset) },
  })),
  entry(MissingConversionFloorError, (e) => ({
    code: "conversion_floor_missing",
    status: 422,
    message: e.message,
    details: { decisionId: tokenDecisionId(e.contract) },
  })),
  entry(UnrecognizedConversionProviderError, (e) => ({
    code: "conversion_provider_unrecognized",
    status: 422,
    message: e.message,
    details: { decisionId: tokenDecisionId(e.contract) },
  })),
];

export function mapDomainError(
  entries: readonly DomainErrorEntry[],
  error: unknown
): MappedError | null {
  for (const candidate of entries) {
    const mapped = candidate.map(error);
    if (mapped) return mapped;
  }
  return null;
}
