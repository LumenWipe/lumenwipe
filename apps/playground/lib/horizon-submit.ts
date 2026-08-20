// Playground classic-tx submission via Horizon (testnet only). Horizon is the
// lag-free, single source of truth for classic accounts/sequences and submits
// synchronously, sidestepping the load-balanced Soroban RPC's stale-read /
// bad-seq / no-account failure modes.

const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

export class TxSubmitError extends Error {
  constructor(
    message: string,
    public readonly resultCode: string | null
  ) {
    super(message);
    this.name = "TxSubmitError";
  }
}

/** Read the source account's current sequence from Horizon (zero indexing lag). */
export async function loadHorizonAccount(
  address: string
): Promise<{ sequenceNumber: () => string }> {
  const res = await fetch(`${HORIZON_TESTNET_URL}/accounts/${address}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 404) throw new Error(`Account not found: ${address}`);
  if (!res.ok) throw new Error(`Horizon account fetch failed (${res.status})`);
  const json = (await res.json()) as { sequence: string };
  return { sequenceNumber: () => json.sequence };
}

interface HorizonSubmitResponse {
  successful?: boolean;
  hash?: string;
  extras?: { result_codes?: { transaction?: string; operations?: string[] } };
}

/** Submit a signed classic transaction and wait for inclusion via Horizon. */
export async function submitClassicViaHorizon(signedXdr: string): Promise<{ txHash: string }> {
  const res = await fetch(`${HORIZON_TESTNET_URL}/transactions`, {
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

  if (res.status === 503 || res.status === 504) {
    throw new TxSubmitError(
      "The network is taking longer than usual to confirm. Please try again.",
      null
    );
  }

  const code = json?.extras?.result_codes?.transaction ?? null;
  throw new TxSubmitError(
    code ? `Transaction rejected: ${code}` : "Transaction rejected by the network.",
    code
  );
}
