import type {
  ClosePlanRequest,
  CloseTransactionsRequest,
  PlanResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import { readApiError } from "@/lib/utils/user-error";

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
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
  return (await res.json()) as TransactionsResponse;
}
