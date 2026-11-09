// Playground classic-tx submission via Horizon (testnet only). Horizon is the
// lag-free, single source of truth for classic accounts/sequences and submits
// synchronously, sidestepping the load-balanced Soroban RPC's stale-read /
// bad-seq / no-account failure modes.

/** The single source for the playground's Horizon base URL - imported rather than repeated,
 *  so pointing the playground at a different Horizon is a one-line change. */
export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

export class TxSubmitError extends Error {
  constructor(
    message: string,
    public readonly resultCode: string | null
  ) {
    super(message);
    this.name = "TxSubmitError";
  }
}

const READ_TIMEOUT_MS = 15_000;
/** Horizon answers a submission within about 30 seconds, with a 504 when it is still pending. */
const SUBMIT_TIMEOUT_MS = 45_000;

const readAccount = (address: string): Promise<Response> =>
  fetch(`${HORIZON_TESTNET_URL}/accounts/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });

/** Read the source account's current sequence from Horizon (zero indexing lag). */
export async function loadHorizonAccount(
  address: string
): Promise<{ sequenceNumber: () => string }> {
  const res = await readAccount(address);
  if (res.status === 404) throw new Error(`Account not found: ${address}`);
  if (!res.ok) throw new Error(`Horizon account fetch failed (${res.status})`);
  const json = (await res.json()) as { sequence: string };
  return { sequenceNumber: () => json.sequence };
}

/** An account's XLM as Horizon reports it: the balance, and the part its offers have committed. */
export interface NativeBalance {
  balance: string;
  sellingLiabilities: string;
}

interface HorizonAccountBalances {
  balances?: { asset_type?: string; balance?: string; selling_liabilities?: string }[];
}

/** The account's XLM; throws for a missing account or an unreadable answer. */
export async function loadNativeBalance(address: string): Promise<NativeBalance> {
  const res = await readAccount(address);
  if (!res.ok) throw new Error(`Horizon account fetch failed (${res.status})`);
  const json = (await res.json()) as HorizonAccountBalances;
  const native = json.balances?.find((b) => b.asset_type === "native");
  if (typeof native?.balance !== "string") throw new Error("Horizon account has no XLM balance");
  return { balance: native.balance, sellingLiabilities: native.selling_liabilities ?? "0" };
}

/** False only for Horizon's 404; any other failure throws, so it is never read as "gone". */
export async function accountExists(address: string): Promise<boolean> {
  const res = await readAccount(address);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon account fetch failed (${res.status})`);
  return true;
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
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
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
