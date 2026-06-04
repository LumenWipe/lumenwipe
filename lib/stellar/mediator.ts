import type { Network } from "@/config/networks";

/**
 * Asks the backend to co-sign the shared-mediator forward payment leg of the
 * atomic exchange-merge transaction. The user has already signed their half
 * (the account merge); the backend validates the transaction shape and adds
 * the mediator's signature (see app/api/[network]/mediator/sign). It cannot
 * change the destination or amount, so it can never divert funds.
 *
 * @returns the fully-signed transaction XDR, ready to submit.
 */
export async function requestMediatorCosignature(
  userSignedXdr: string,
  network: Network
): Promise<string> {
  const res = await fetch(`/api/${network}/mediator/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: userSignedXdr }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(data.error ?? "Failed to obtain mediator co-signature.");
  }
  const { transaction } = (await res.json()) as { transaction: string };
  return transaction;
}
