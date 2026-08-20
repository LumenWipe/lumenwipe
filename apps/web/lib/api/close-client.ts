import type {
  ClosePlanRequest,
  CloseTransactionsRequest,
  PlanResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";

/**
 * Reads the API's error message out of the proxy response.
 *
 * The API emits one envelope now - `{ error: { code, message } }` - so this no longer has to
 * guess. The string branch is kept only for a response that predates the unification (a cached
 * proxy response, an older deployed API during a rollout); it is a compatibility shim with an
 * expiry, not a second supported contract.
 */
async function toError(res: Response): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
  };
  if (typeof data.error === "object" && data.error?.message) return new Error(data.error.message);
  if (typeof data.error === "string") return new Error(data.error);
  return new Error(`Request failed (${res.status}).`);
}

/** Builds the deterministic close plan (decision points, estimate) via the proxy. */
export async function fetchClosePlan(
  body: ClosePlanRequest,
  network: Network
): Promise<PlanResponse> {
  const res = await fetch(`/api/v1/${network}/close/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as PlanResponse;
}

/**
 * Requests the next batch of unsigned close transactions via the proxy. A close can span
 * several rounds: sign + submit the returned transactions, then call again while
 * `remaining.requiresAnotherCall` is true.
 */
export async function fetchCloseTransactions(
  body: CloseTransactionsRequest,
  network: Network
): Promise<TransactionsResponse> {
  const res = await fetch(`/api/v1/${network}/close/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TransactionsResponse;
}
