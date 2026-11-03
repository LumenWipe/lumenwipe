import {
  CloseDidNotConvergeError,
  CloseOutcomeUnknownError,
  CloseTransactionFailedError,
  LumenWipeApiError,
  LumenWipeTimeoutError,
} from "@lumenwipe/sdk";
import { apiRequestId } from "@/lib/api/error-body";
import { InvalidPreAuthTxError } from "@/lib/stellar/pre-auth-tx";
import { InvalidPreimageError } from "@/lib/stellar/hash-x";
import { VerificationError } from "@/lib/stellar/verify";
import { RevokeAllowanceVerificationError } from "@/lib/stellar/verify-revoke-allowance";
import { TxSubmitError } from "@/lib/utils/errors";
import { allows } from "@/lib/journey/claims";
import { deriveJourneyState, type Journey } from "@/lib/journey/journey-state";
import type { PlannedStep } from "@/types/plan";

export type ErrorContext = "analyze" | "review" | "execute" | "wallet" | "generic";

/** An error whose message was written for the user and is safe to render as-is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** A non-2xx answer from the API proxy. The message is the API's own and is only shown when it
 *  reads as plain language; the status decides everything else. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
    /** The envelope's `error.code`, which the close loop branches on; never shown. */
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** The API refused a request because the account moved under its read; nothing was built. */
export function isStateChanged(err: unknown): boolean {
  return err instanceof ApiRequestError && err.code === "state_changed";
}

const FALLBACKS: Record<ErrorContext, string> = {
  analyze:
    "We couldn't analyze this account right now. Please check your connection and try again.",
  review: "We couldn't prepare this step. Please go back, check your details and try again.",
  execute:
    "The close could not be completed. Check your account if you're unsure what happened, then try again - the close picks up where it stopped.",
  wallet: "We couldn't reach your wallet. Make sure it's unlocked and try again.",
  generic: "Something went wrong. Please try again.",
};

const DECLINED = /declin|reject|den(y|ied)|cancel|dismiss|user closed|closed the/i;
const DECLINED_CONNECTION =
  "You declined the connection request in your wallet, so it was not connected. Approve it when you're ready to continue.";
const DECLINED_TRANSACTION =
  "You declined the request in your wallet. This transaction was not signed or sent - approve it when you're ready to continue.";
const VERIFICATION_FAILED =
  "This transaction doesn't match what you approved, so it was not signed or sent. Contact support if it keeps happening.";

const WALLET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/locked|unlock/i, "Your wallet is locked. Unlock it and try again."],
  [
    /not (installed|found|available|connected)|no wallet|extension/i,
    "We couldn't find your wallet. Make sure the extension is installed and connected, then try again.",
  ],
  [/time(d)? ?out/i, "Your wallet didn't respond in time. Open it, then try again."],
];

const HTTP_MESSAGES: Record<number, string> = {
  401: "The service couldn't authorize this request. Please try again shortly.",
  403: "The service couldn't authorize this request. Please try again shortly.",
  404: "We couldn't find that on this network. Check the address and the selected network.",
  429: "Too many requests right now. Wait a moment and try again.",
};

const UNAVAILABLE = "The service is temporarily unavailable. Please try again in a moment.";

function looksPlain(message: string): boolean {
  return (
    message.length > 0 &&
    message.length <= 240 &&
    !/\b(tx|op)_[a-z_]+\b/.test(message) &&
    !/\b\w*(Error|Exception)\b|\bat \S+ \(|undefined|\[object|[{}]|\(\d{3}\)/.test(message)
  );
}

function envelopeField(body: unknown, field: "code" | "message"): string {
  if (typeof body !== "object" || body === null) return "";
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function envelopeMessage(body: unknown): string {
  return envelopeField(body, "message");
}

/**
 * The plain-language message in an `{ error: { code, message } }` body, else the fallback. The
 * body comes from `res.json()`, which is `any`, so its shape is checked here rather than trusted:
 * anything else, including a flat `{ error: "..." }`, reads as the fallback.
 */
export function apiErrorText(body: unknown, fallback: string): string {
  const message = envelopeMessage(body);
  return looksPlain(message) ? message : fallback;
}

/** Reads a failed proxy response into an `ApiRequestError`, whose message `toUserMessage` alone
 *  decides whether to show. */
export async function readApiError(res: Response, fallback = ""): Promise<ApiRequestError> {
  const body: unknown = await res.json().catch(() => ({}));
  return new ApiRequestError(
    res.status,
    envelopeMessage(body) || fallback,
    apiRequestId(res, body),
    envelopeField(body, "code") || undefined
  );
}

function rawMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function fromStatus(status: number, apiMessage: string, context: ErrorContext): string {
  const mapped = HTTP_MESSAGES[status];
  if (mapped) return mapped;
  if ((status === 400 || status === 422) && looksPlain(apiMessage)) return apiMessage;
  if (status >= 500) return UNAVAILABLE;
  return FALLBACKS[context];
}

/** The id to quote when reporting a failed API call, when the error came from one. */
export function requestIdOf(err: unknown): string | undefined {
  if (err instanceof ApiRequestError || err instanceof LumenWipeApiError) return err.requestId;
  return undefined;
}

/**
 * Turns anything thrown in the close flow into copy that is safe to render. Raw SDK, wallet and
 * network text never passes through: unknown errors collapse to a context-specific fallback and
 * the original is logged for debugging instead.
 */
export function toUserMessage(err: unknown, context: ErrorContext = "generic"): string {
  if (
    err instanceof UserFacingError ||
    err instanceof CloseDidNotConvergeError ||
    err instanceof CloseOutcomeUnknownError ||
    err instanceof InvalidPreAuthTxError ||
    err instanceof InvalidPreimageError ||
    err instanceof RevokeAllowanceVerificationError ||
    err instanceof TxSubmitError
  ) {
    return err.message;
  }
  if (err instanceof VerificationError) return VERIFICATION_FAILED;
  if (err instanceof CloseTransactionFailedError) {
    return looksPlain(err.message) ? err.message : FALLBACKS[context];
  }
  if (err instanceof ApiRequestError) return fromStatus(err.status, err.message, context);
  if (err instanceof LumenWipeApiError) return fromStatus(err.status, "", context);
  if (err instanceof LumenWipeTimeoutError) return UNAVAILABLE;

  const message = rawMessage(err);
  if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    return "We couldn't reach the service. Please check your connection and try again.";
  }
  if (context === "execute" || context === "wallet") {
    if (DECLINED.test(message)) {
      return context === "wallet" ? DECLINED_CONNECTION : DECLINED_TRANSACTION;
    }
    const wallet = WALLET_PATTERNS.find(([pattern]) => pattern.test(message));
    if (wallet) return wallet[1];
  }

  console.error("[close-flow] unmapped error:", err);
  return FALLBACKS[context];
}

/** Whether the transaction in flight when a close failed had already been handed to the network. */
export type CloseFailureStage = "before-submit" | "submitted" | "refused";

/** Shown while a transaction's outcome is unknown. Claims neither a failure nor a success. */
export const UNCONFIRMED_NOTICE =
  "This transaction is not confirmed yet, and your account may already be closed. Check again before doing anything else.";
export const STILL_UNCONFIRMED_NOTICE =
  "Still not confirmed. The network has no answer for this transaction yet, so check again in a moment.";
export const CLOSE_FINISHED_NOTICE =
  "This close is finished: the merge you signed is confirmed on the network.";

export const CLOSE_INTERRUPTED =
  "This close was interrupted because another account was started in this tab, so nothing more was sent for it.";
export const HASH_NOT_KEPT =
  "This browser could not save the details needed to check this transaction if the page is lost, so it was held back. Allow this site to store data, then try again.";
export const OUTCOME_HELD =
  "This account has a transaction whose outcome is unknown, and a revoke would use the same sequence number, so nothing was signed or sent. Open the close page on this network and choose Check again first.";
export const CONFIRM_HELD =
  "This account has a transaction whose outcome is unknown, so this plan was not started. Open the start page on this network and choose Check again first.";
export const CONFIRM_UNCHECKED =
  "The saved state of this close could not be checked, so this plan was not started. Try again.";
export const CONFIRM_NOT_SAVED =
  "This close is no longer the one open in this tab, so it was not saved and this confirm did not start it. Review the plan again before you continue.";
export const CONFIRM_SAVE_FAILED =
  "This browser could not save the close, so this confirm did not start it. Allow this site to store data, then try again.";
export const NO_MERGE_CONFIRMED =
  "The service reported this close as finished, but no confirmed transaction merged this account, so it is not closed. Look the account up on an explorer, then try again.";
export const CHECK_FAILED_NOTICE =
  "That transaction failed on the network. Look at your account on an explorer, then resume the close.";

export const PREIMAGE_EXPOSED =
  "That transaction carried your preimage, so treat it as public: anyone who read it holds that signer's weight until the signer is removed. Do not assume this is harmless. Removing the signer is the next thing to do.";
const REFUSED = "Its operations did not take effect";
const ACCOUNT_GONE =
  "This account is no longer on the network, and this close could not confirm that it was what removed it. Look the account up on an explorer to see what happened.";

function isAccountGone(err: unknown): boolean {
  return err instanceof ApiRequestError && err.code === "account_not_found";
}

const UNCONFIRMED = "The last transaction could not be confirmed, so check it on the explorer";
const UNCONFIRMED_RETRY =
  "; retrying is also safe, because LumenWipe re-reads your account first and never sends a confirmed transaction twice.";

function progressSentence(journey: Journey): string | null {
  if (journey.confirmed === 0) return null;
  const count = `${journey.confirmed} of ${journey.total} plan steps are already confirmed`;
  return allows(journey, "account-closed")
    ? `${count}, so your account is closed.`
    : `${count}, so your account is partly closed and still open.`;
}

/**
 * The message for a close that stopped part way. Every claim is scoped to the one transaction
 * in flight, because earlier rounds may already be on the ledger; what is confirmed is read only
 * from the plan's confirmed steps, and retrying is called safe only where the journey allows it.
 * Its journey is built with inFlight false and saved true, because each stage describes a
 * transaction that is not, or no longer, the one in flight; the submitted stage's retry sentence is
 * unchanged from before.
 */
export function closeFailureMessage(
  err: unknown,
  stage: CloseFailureStage,
  plan: readonly PlannedStep[],
  carriedPreimage = false
): string {
  if (isAccountGone(err)) return ACCOUNT_GONE;
  const base = toUserMessage(err, "execute");
  const journey = deriveJourneyState({ phase: "STEP_FAILED", plan, inFlight: false, saved: true });
  const progress = progressSentence(journey);
  const retrySafe = allows(journey, "safe-to-retry");
  if (stage === "refused") {
    const refused = `${REFUSED}${retrySafe ? ", so it is safe to retry." : "."}`;
    return [base, progress, carriedPreimage ? PREIMAGE_EXPOSED : refused].filter(Boolean).join(" ");
  }
  if (stage === "submitted") {
    const unconfirmed = `${UNCONFIRMED}${retrySafe ? UNCONFIRMED_RETRY : "."}`;
    return [base, progress, unconfirmed].filter(Boolean).join(" ");
  }
  const scoped = base === DECLINED_TRANSACTION || base === VERIFICATION_FAILED;
  return [
    base,
    scoped || !allows(journey, "no-new-sent") ? null : "No new transaction was sent.",
    progress,
    retrySafe ? "It is safe to retry." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Whether the note under Retry may say so. Goes with `closeFailureMessage`, same arguments. */
export function closeRetryIsSafe(
  err: unknown,
  stage: CloseFailureStage,
  carriedPreimage = false
): boolean {
  return !isAccountGone(err) && !(stage === "refused" && carriedPreimage);
}
