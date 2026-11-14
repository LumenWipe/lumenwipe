import { LumenWipeClient, type FetchLike } from "@lumenwipe/sdk";

/** The SDK's own per-request timeout, longer than the API's 40-second deadline. */
export const READ_TIMEOUT_MS = 45_000;

/** The longest wait the SDK honors from a `Retry-After` before it asks again. */
export const READ_RETRY_WAIT_MS = 30_000;

/** What a route needs for a read that waits out one busy answer: two attempts and the wait. */
export const READ_RETRY_ROUTE_BUDGET_MS = 2 * READ_TIMEOUT_MS + READ_RETRY_WAIT_MS;

/**
 * A client for the reads a route makes that change nothing: an account read or a plan. A busy or
 * throttled answer is waited out for its `Retry-After` and the read made once more. Never used for
 * a build, a submit or a signature: those go through a client without retries.
 */
export function readClient(baseUrl: string, apiKey: string, fetch?: FetchLike): LumenWipeClient {
  return new LumenWipeClient({
    baseUrl,
    apiKey,
    network: "testnet",
    timeout: READ_TIMEOUT_MS,
    retry: { attempts: 2, baseDelayMs: 1_000 },
    ...(fetch ? { fetch } : {}),
  });
}
