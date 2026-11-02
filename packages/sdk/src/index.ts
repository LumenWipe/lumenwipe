export { LumenWipeClient } from "./client";
export {
  LumenWipeAbortError,
  LumenWipeApiError,
  LumenWipeTimeoutError,
  isApiErrorCode,
  type ApiErrorCode,
} from "./errors";
export type { FetchLike, LumenWipeClientOptions, RequestOptions, RetryOptions } from "./options";

// Re-export the API contract types for convenience.
export type * from "@lumenwipe/types";

export {
  runClose,
  InsufficientSignatureWeightError,
  CloseDidNotConvergeError,
  CloseStateChangedError,
  CloseOutcomeUnknownError,
  CloseTransactionFailedError,
  isSubmitRefused,
  resolveSubmission,
  submissionClosesAccount,
  SUBMIT_RESEND_ATTEMPTS,
  SUBMIT_RESEND_DELAY_MS,
  SUBMISSION_GIVE_UP_MARGIN_SECONDS,
  STATE_CHANGED_REFETCHES,
  STATE_CHANGED_REFETCH_DELAY_MS,
  type CloseDidNotConvergeReason,
  type PendingRound,
  type CloseEngineDeps,
  type CloseReconciliation,
  type SubmissionOutcome,
  type UnresolvedSubmission,
} from "./close-engine";
