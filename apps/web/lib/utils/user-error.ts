import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";
import { looksPlain } from "@/lib/api/error-body";
import { InvalidPreAuthTxError } from "@/lib/stellar/pre-auth-tx";
import { InvalidPreimageError } from "@/lib/stellar/hash-x";
import { VerificationError } from "@/lib/stellar/verify";
import { RevokeAllowanceVerificationError } from "@/lib/stellar/verify-revoke-allowance";
import { TxSubmitError, TxTimeoutError } from "@/lib/utils/errors";

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
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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

const WALLET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /declin|reject|den(y|ied)|cancel|dismiss|user closed|closed the/i,
    "You declined the request in your wallet. Nothing was sent - approve it when you're ready to continue.",
  ],
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

/**
 * Turns anything thrown in the close flow into copy that is safe to render. Raw SDK, wallet and
 * network text never passes through: unknown errors collapse to a context-specific fallback and
 * the original is logged for debugging instead.
 */
export function toUserMessage(err: unknown, context: ErrorContext = "generic"): string {
  if (
    err instanceof UserFacingError ||
    err instanceof InvalidPreAuthTxError ||
    err instanceof InvalidPreimageError ||
    err instanceof RevokeAllowanceVerificationError ||
    err instanceof TxSubmitError ||
    err instanceof TxTimeoutError
  ) {
    return err.message;
  }
  if (err instanceof VerificationError) {
    return "This transaction doesn't match what you approved, so it was not signed. Nothing was sent. Please start again, and contact support if it keeps happening.";
  }
  if (err instanceof ApiRequestError) return fromStatus(err.status, err.message, context);
  if (err instanceof LumenWipeApiError) return fromStatus(err.status, "", context);
  if (err instanceof LumenWipeTimeoutError) return UNAVAILABLE;

  const message = rawMessage(err);
  if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) {
    return "We couldn't reach the service. Please check your connection and try again.";
  }
  const wallet = WALLET_PATTERNS.find(([pattern]) => pattern.test(message));
  if (wallet && (context === "execute" || context === "wallet")) return wallet[1];

  console.error("[close-flow] unmapped error:", err);
  return FALLBACKS[context];
}
