import type { Network } from "@/config/networks";

export interface SubmitResult {
  txHash: string;
  ledger: number;
}

/**
 * Submits a client-signed transaction through the server-side proxy
 * (`POST /api/v1/:network/submit` → apps/api), which relays it to the network
 * and waits for confirmation. The browser never talks to Stellar RPC directly;
 * signing stays client-side, submission is the API's job.
 */
export async function submitViaApi(signedXdr: string, network: Network): Promise<SubmitResult> {
  const res = await fetch(`/api/v1/${network}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedXdr }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    hash?: string;
    ledger?: number;
    error?: { message?: string } | string;
  };

  if (!res.ok) {
    const message =
      typeof data.error === "object" && data.error?.message
        ? data.error.message
        : typeof data.error === "string"
          ? data.error
          : "Failed to submit the transaction.";
    throw new Error(message);
  }

  // A 2xx with no hash means the response contract drifted; fail loudly rather
  // than marking a step "confirmed" with an empty hash.
  if (!data.hash) {
    throw new Error("The transaction was submitted but the server returned no hash.");
  }

  return { txHash: data.hash, ledger: data.ledger ?? 0 };
}
