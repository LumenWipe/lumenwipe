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
import {
  SignerReleasedError,
  WalletNotUsableError,
  WalletSignerMismatchError,
  WalletSigningError,
  WalletSigningTimeoutError,
  WalletWrongNetworkError,
} from "@/lib/stellar/signer";
import { NETWORK_NAME, NETWORK_PASSPHRASES, type Network } from "@/config/networks";
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
    readonly code?: string,
    /** The wait the answer's `Retry-After` asked for, when it gave a number of seconds. */
    readonly retryAfterSeconds?: number
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
  analyze: "We couldn't analyze this account right now. Please try again.",
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

/** Shown when a wallet's signing prompt was given up on. Whatever the wallet answers later is
 *  dropped, so the user is told to decline it rather than wonder whether it was used. */
export const WALLET_TIMED_OUT =
  "Your wallet didn't respond in time, so this transaction was not signed or sent. Close the earlier prompt in your wallet before you try again: a signature given there now will not be used. You can also change wallet or key.";
/** A wallet declined to sign a partly signed transaction, which is kept for the next attempt. */
export const KEPT_ROUND_DECLINED =
  "You declined the request in your wallet, so this transaction was not sent. The signatures already collected on it are kept: sign again or connect another signer to continue.";
/** A wallet did not answer in time on a partly signed transaction, which is kept for the next
 *  attempt. Its prompt may still be open, so the user is told to close it. */
export const KEPT_ROUND_TIMED_OUT =
  "Your wallet didn't respond in time, so this transaction was not sent. The signatures already collected on it are kept. Close the earlier prompt in your wallet before you sign again: a signature given there now will not be used.";
/** A partly signed transaction passed its time limit before it had enough signing weight. */
export const PENDING_ROUND_EXPIRED =
  "The partly signed transaction expired before it had enough signing weight, so it was not sent. Retry to build a new transaction: each signer will be asked to sign it again.";
/** A run whose signer the screen dropped, stopped before its next signature. */
export const SIGNER_RELEASED =
  "Signing stopped because the signer was cleared. Enter or connect a signer to continue.";
/** A wallet that reported signing with another account than the one it was asked for. */
export function walletAccountMismatch(reported: string, expected: string): string {
  const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
  return `Your wallet signed with a different account (${short(reported)}). Switch your wallet to ${short(expected)}, or disconnect it and choose a wallet that holds one of this account's signers.`;
}

/** A wallet that signed for another network than the page's. */
export function walletWrongNetwork(network: Network | null): string {
  return network
    ? `Your wallet signed for a different network than this page. Switch your wallet to ${NETWORK_NAME[network]} and try again.`
    : "Your wallet signed for a different network than this page. Switch your wallet to this page's network and try again.";
}

/** A wallet session that stopped being usable during a run, found before the wallet was asked. */
export function walletNotUsable(reason: WalletNotUsableError["reason"], network: Network): string {
  if (reason === "network") {
    return `Your wallet is now on a different network than this page, so the wallet was not asked to sign. Switch it to ${NETWORK_NAME[network]}, then retry.`;
  }
  if (reason === "network-unconfirmed") {
    return `Your wallet's network needs confirming again, so the wallet was not asked to sign. Confirm it is set to ${NETWORK_NAME[network]}, then retry.`;
  }
  return "Your wallet session changed before this signature, so the wallet was not asked to sign. Reconnect your wallet, then retry.";
}

function networkOf(passphrase: string): Network | null {
  const found = (Object.entries(NETWORK_PASSPHRASES) as [Network, string][]).find(
    ([, p]) => p === passphrase
  );
  return found ? found[0] : null;
}

/** Added to a refusal when this device's clock already said the transaction had expired. */
export const CLOCK_HINT =
  "If this keeps happening, check that your device's clock is set correctly.";
const WALLET_UNSUPPORTED =
  "Your wallet can't sign this transaction. Change to another wallet or your secret key, then try again.";

/** What each wallet kit error code means, when the wallet's own text says nothing more. */
const WALLET_CODES: Record<number, string> = {
  [-1]: "Your wallet ran into a problem and did not sign. Open it, check it's unlocked, then try again.",
  [-2]: "Your wallet could not complete the request and did not sign. Open it and try again.",
  [-3]: WALLET_UNSUPPORTED,
};

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
const PROVIDER_BUSY =
  "The service LumenWipe reads the Stellar network through is busy or not answering right now. This is not a problem with your connection.";
const REFRESH_BUSY =
  "The plan could not be checked again because the service LumenWipe reads the Stellar network through is busy or not answering, so signing has not started. This is not a problem with your connection.";

/** When to try again, from the seconds a `Retry-After` asked for. Never a countdown: the user
 *  may retry whenever they like. */
export function retryWhen(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "Try again in a moment.";
  }
  if (seconds < 60) return `Try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** A 503: the API, or a data provider behind it, is rate limited, too slow or unavailable. */
function isServiceBusy(err: unknown): err is ApiRequestError | LumenWipeApiError {
  return (err instanceof ApiRequestError || err instanceof LumenWipeApiError) && err.status === 503;
}

function retryAfterOf(err: ApiRequestError | LumenWipeApiError): number | undefined {
  if (err instanceof ApiRequestError) return err.retryAfterSeconds;
  return err.retryAfterMs === undefined ? undefined : Math.ceil(err.retryAfterMs / 1000);
}

/** The delta-seconds form only: the proxy relays the API's wait in that form. */
function retryAfterSecondsOf(header: string | null): number | undefined {
  return header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
}

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
    envelopeField(body, "code") || undefined,
    retryAfterSecondsOf(res.headers.get("Retry-After"))
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
/**
 * A wallet's refusal, read from the kit's code first. Its own text is only consulted for an error
 * that is typed as the wallet's, and only to tell a locked or missing wallet from another
 * failure; it is never shown.
 */
function walletSigningMessage(err: WalletSigningError): string {
  if (err.code === -4) return DECLINED_TRANSACTION;
  if (err.code === -3) return WALLET_UNSUPPORTED;
  // -1 is the kit's catch-all, which some wallets use for a decline; any other code says what it is.
  if (err.code === -1 && DECLINED.test(err.message)) return DECLINED_TRANSACTION;
  const pattern = WALLET_PATTERNS.find(([re]) => re.test(err.message));
  if (pattern) return pattern[1];
  return WALLET_CODES[err.code] ?? FALLBACKS.wallet;
}

export function toUserMessage(err: unknown, context: ErrorContext = "generic"): string {
  if (err instanceof WalletSigningTimeoutError) return WALLET_TIMED_OUT;
  if (err instanceof WalletSigningError) return walletSigningMessage(err);
  if (err instanceof WalletSignerMismatchError) {
    return walletAccountMismatch(err.reported, err.expected);
  }
  if (err instanceof WalletWrongNetworkError) return walletWrongNetwork(networkOf(err.requested));
  if (err instanceof WalletNotUsableError) return walletNotUsable(err.reason, err.network);
  if (err instanceof SignerReleasedError) return SIGNER_RELEASED;
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
  if (isServiceBusy(err)) return `${PROVIDER_BUSY} ${retryWhen(retryAfterOf(err))}`;
  if (err instanceof ApiRequestError) return fromStatus(err.status, err.message, context);
  if (err instanceof LumenWipeApiError) return fromStatus(err.status, "", context);
  if (err instanceof LumenWipeTimeoutError) return UNAVAILABLE;

  const message = rawMessage(err);
  if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    return "We couldn't reach the service. Please check your connection and try again.";
  }
  // The connection flow has no typed error to read yet, so its patterns stay. A signing failure is
  // only ever a WalletSigningError, handled above: in the execute context, a message that merely
  // reads like a wallet's ("request timed out") is not one.
  if (context === "wallet") {
    if (DECLINED.test(message)) return DECLINED_CONNECTION;
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

/** Shown on /analyze after a reload of /review handed this tab's saved choices back to it. */
export const REVIEW_RESTORED =
  "The page was reloaded, so the plan is being built again from your account as it is now. Your choices for this account were kept in this tab: check them, then continue to review.";
export const CHOICES_RESTORED =
  "Your earlier choices for this account were kept in this tab. Check them before you continue.";

export function reviewResetNotice(reason: string): string {
  return `Your review was reset because the page was reloaded: ${reason}. Make your choices again, then continue to review.`;
}

export function choicesResetNotice(reason: string): string {
  return `Your choices were reset because ${reason}. Make them again before you continue.`;
}

/** Shown when restored choices meet a return to an issuer or DeFi positions: the confirmations
 *  that give value up are never restored. */
export const CONFIRMATIONS_ASKED_AGAIN =
  "Confirmations that give value up are not kept across a reload: any return to an issuer and any DeFi position check or position left behind is asked again below.";

export function changedAssetsNotice(assets: readonly string[]): string {
  return `These assets changed since you chose what to do with them, so they need an answer again: ${assets.join(", ")}.`;
}

/** Shown on /analyze when the account read found no account and a saved close of it was removed.
 *  It does not say the close finished: a missing account is not proof of that. */
export const GONE_RECORD_CLEARED =
  "This account no longer exists on the network, so this browser's saved record of a close for it was removed. Look the account up on an explorer to see what happened to it.";

export const CLOSE_INTERRUPTED =
  "This close was interrupted because another account was started in this tab, so nothing more was sent for it.";
export const HASH_NOT_KEPT =
  "This browser could not save the details needed to check this transaction if the page is lost, so it was held back. Allow this site to store data, then try again.";
/** A signer returned a transaction other than the one that was verified, so it was not sent. */
export const SIGNED_NOT_APPROVED = "The signed transaction does not match what you approved.";
export const OUTCOME_HELD =
  "This account has a transaction whose outcome is unknown, and a revoke would use the same sequence number, so nothing was signed or sent. Open the close page on this network and choose Check again first.";
export const CONFIRM_HELD =
  "This account has a transaction whose outcome is unknown, so this plan was not started. Open the start page on this network and choose Check again first.";
export const CONFIRM_UNCHECKED =
  "The saved state of this close could not be checked, so this plan was not started. Try again.";
export const CONFIRM_NOT_SAVED =
  "This close is no longer the one open in this tab, so it was not saved and this confirm did not start it. Review the plan again before you continue.";
export const CONFIRM_SAVE_FAILED =
  "This browser could not save the close, so this confirm did not start it. A close needs this browser's storage to keep track of any transaction whose outcome is not known yet. Allow this site to store data, then try again.";
/** /review checks the plan again before signing; these say why it did not move on. */
export const PLAN_REFRESH_FAILED =
  "The plan could not be checked again just now, so signing has not started. Check your connection and try again.";
export const PLAN_REFRESH_UNUSABLE =
  "The plan could not be checked again just now, so signing has not started. Try again in a moment.";
export const PLAN_NEEDS_ANSWERS =
  "Something on the account changed and needs an answer before this close can go on. Go back to decide what happens to it.";
export const PLAN_REVIEW_LEFT =
  "The review changed while the plan was being checked, so signing has not started. Review the plan again before you continue.";
export const PLAN_FLOOR_MISSING =
  "A swap in this plan has no minimum amount recorded, so what it delivers cannot be checked. Go back to choose again what happens to that asset.";
export const PLAN_FEES_UNREADABLE =
  "The plan's network fees could not be read, so signing has not started. Try again in a moment.";
export const PLAN_NOT_COMPARABLE =
  "This plan could not be compared with the one you reviewed. Go back to decide, then review it again.";
export const PLAN_HOLDINGS_CHANGED =
  "What the account holds changed since this plan was prepared, so its choices need to be made again. Go back to decide what happens to each item.";

/** Why /review's check of the plan failed: a busy service, another answer, or no answer at all. */
export function planRefreshFailure(err: unknown): string {
  if (isServiceBusy(err)) return `${REFRESH_BUSY} ${retryWhen(retryAfterOf(err))}`;
  if (err instanceof ApiRequestError || err instanceof LumenWipeApiError) {
    return PLAN_REFRESH_UNUSABLE;
  }
  return PLAN_REFRESH_FAILED;
}

export const PROGRESS_NOT_SAVED =
  "This browser could not save the progress of this close. Signing goes on, but if this page is lost the start page may not show how far the close got.";
export const NO_MERGE_CONFIRMED =
  "The service reported this close as finished, but no confirmed transaction merged this account, so it is not closed. Look the account up on an explorer, then try again.";
export const CHECK_FAILED_NOTICE =
  "That transaction failed on the network. Look at your account on an explorer, then resume the close.";

export const PREIMAGE_EXPOSED =
  "That transaction carried your preimage, so treat it as public: anyone who read it holds that signer's weight until the signer is removed. Do not assume this is harmless. Removing the signer is the next thing to do.";
const REFUSED = "Its operations did not take effect";
const ACCOUNT_GONE =
  "This account is no longer on the network, and this close could not confirm that it was what removed it. Look the account up on an explorer to see what happened.";

export function isAccountGone(err: unknown): boolean {
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
  carriedPreimage = false,
  /** This device's clock was already past the refused transaction's `maxTime`. */
  clockPastExpiry = false
): string {
  if (isAccountGone(err)) return ACCOUNT_GONE;
  const base = toUserMessage(err, "execute");
  const journey = deriveJourneyState({ phase: "STEP_FAILED", plan, inFlight: false, saved: true });
  const progress = progressSentence(journey);
  const retrySafe = allows(journey, "safe-to-retry");
  if (stage === "refused") {
    const refused = `${REFUSED}${retrySafe ? ", so it is safe to retry." : "."}`;
    return [
      base,
      progress,
      carriedPreimage ? PREIMAGE_EXPOSED : refused,
      clockPastExpiry ? CLOCK_HINT : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (stage === "submitted") {
    const unconfirmed = `${UNCONFIRMED}${retrySafe ? UNCONFIRMED_RETRY : "."}`;
    return [base, progress, unconfirmed].filter(Boolean).join(" ");
  }
  const scoped =
    base === DECLINED_TRANSACTION || base === VERIFICATION_FAILED || base === WALLET_TIMED_OUT;
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
