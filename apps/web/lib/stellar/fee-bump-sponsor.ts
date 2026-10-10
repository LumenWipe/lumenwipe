import type { Network } from "@/config/networks";
import { apiRequestId } from "@/lib/api/error-body";
import { ApiRequestError, UserFacingError } from "@/lib/utils/user-error";

/**
 * Asks the backend to wrap a wind-down transaction - built with its own fee already at zero,
 * because the account cannot pay its own way (architecture.md §8.1) - in a signed CAP-15
 * fee-bump envelope. The backend validates the transaction's shape and holds the fee-account
 * secret (see app/api/[network]/fee-bump/sponsor); it can only ever pay its own fee, never move
 * the account's own funds.
 *
 * @returns the fee-bump-wrapped, fully-signed transaction XDR, ready for `submitViaApi`.
 */
export async function requestFeeBumpSponsorship(
  signedXdr: string,
  network: Network
): Promise<string> {
  const res = await fetch(`/api/${network}/fee-bump/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    transaction?: string;
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const message =
      typeof data.error === "object" && data.error?.message
        ? data.error.message
        : typeof data.error === "string"
          ? data.error
          : "Failed to obtain a sponsored fee for this transaction.";
    throw new ApiRequestError(res.status, message, apiRequestId(res, data));
  }
  if (!data.transaction) {
    throw new UserFacingError("The sponsor endpoint returned no transaction.");
  }
  return data.transaction;
}
