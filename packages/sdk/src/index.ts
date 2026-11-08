export { LumenWipeClient } from "./client";
export { LumenWipeIntegratorClient } from "./integrator-client";
export {
  LumenWipeAbortError,
  LumenWipeApiError,
  LumenWipeInvalidNetworkError,
  LumenWipeTimeoutError,
  isApiErrorCode,
  type ApiErrorCode,
} from "./errors";
export type {
  FetchLike,
  LumenWipeClientOptions,
  LumenWipeIntegratorClientOptions,
  RequestOptions,
  RetryOptions,
} from "./options";

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
  type CloseProgressEvent,
  type CloseProgressPhase,
  type CloseRoundProgress,
  type CloseTransactionProgress,
  type PendingRound,
  type CloseEngineDeps,
  type CloseReconciliation,
  type CloseRunResult,
  type SubmissionOutcome,
  type UnresolvedSubmission,
} from "./close-engine";
