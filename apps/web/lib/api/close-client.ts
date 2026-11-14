import type {
  ClosePlanRequest,
  CloseTransactionsRequest,
  PlanResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import { readApiError } from "@/lib/utils/user-error";
import { retryOnceWhenBusy, type BusyRetryOptions } from "@/lib/api/busy-retry";

/** Builds the deterministic close plan (decision points, estimate) via the proxy. Planning
 *  changes nothing, so with `busy` a busy answer is waited out and the plan asked for once more. */
export async function fetchClosePlan(
  body: ClosePlanRequest,
  network: Network,
  signal?: AbortSignal,
  busy?: BusyRetryOptions
): Promise<PlanResponse> {
  const once = async (): Promise<PlanResponse> => {
    const res = await fetch(`/api/v1/${network}/close/plan`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readApiError(res);
    return (await res.json()) as PlanResponse;
  };
  return busy ? retryOnceWhenBusy(once, busy) : once();
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
