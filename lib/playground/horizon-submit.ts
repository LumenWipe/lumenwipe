import { HORIZON_URLS } from "@/config/networks";
import { TxSubmitError, translateRpcError, extractResultCode } from "@/lib/utils/errors";

// Playground classic-tx submission via Horizon. Horizon is the lag-free, single
// source of truth for classic accounts/sequences and submits synchronously
// (holding the request until the tx is included), so it sidesteps the
// load-balanced Soroban RPC's stale-read / bad-seq / no-account / poll-timeout
// failure modes. Raw fetch (not the SDK Horizon Server) to avoid pulling a
// second copy of the SDK into this module - see the v16 dual-build hazard.

const HORIZON = HORIZON_URLS.testnet;

/** Read the source account's current sequence from Horizon (zero indexing lag). */
export async function loadHorizonAccount(
  address: string
): Promise<{ sequenceNumber: () => string }> {
  const res = await fetch(`${HORIZON}/accounts/${address}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  // Phrase the message so loadAccountWithRetry treats a not-yet-ingested account
  // (friendbot funded it microseconds ago) as the transient "account not found".
  if (res.status === 404) throw new Error(`Account not found: ${address}`);
  if (!res.ok) throw new Error(`Horizon account fetch failed (${res.status})`);
  const json = (await res.json()) as { sequence: string };
  return { sequenceNumber: () => json.sequence };
}

interface HorizonSubmitResponse {
  successful?: boolean;
  hash?: string;
  extras?: { result_xdr?: string; result_codes?: { transaction?: string; operations?: string[] } };
}

/** Submit a signed classic transaction and wait for inclusion via Horizon. */
export async function submitClassicViaHorizon(signedXdr: string): Promise<{ txHash: string }> {
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: signedXdr }),
  });

  let json: HorizonSubmitResponse | null = null;
  try {
    json = (await res.json()) as HorizonSubmitResponse;
  } catch {
    json = null;
  }

  if (res.ok && json?.successful && json.hash) {
    return { txHash: json.hash };
  }

  // 503/504: Horizon couldn't confirm inclusion in time. The tx may still land,
  // so surface it as non-retryable (resultCode null) rather than risk a
  // double-submit - the playground shows the error and the user can start over.
  if (res.status === 503 || res.status === 504) {
    throw new TxSubmitError(
      "The network is taking longer than usual to confirm. Please try again.",
      null
    );
  }

  // Decode the specific reason from the result XDR Horizon returns on failure.
  const resultXdr = json?.extras?.result_xdr;
  throw new TxSubmitError(translateRpcError("ERROR", resultXdr), extractResultCode(resultXdr));
}
