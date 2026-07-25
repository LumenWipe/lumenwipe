import type {
  ClosePlanRequest,
  CloseTransactionsRequest,
  PlanResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";

/** Reads the API's error message out of the proxy response, whatever shape it took. */
async function toError(res: Response): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
  };
  const message =
    typeof data.error === "object" && data.error?.message
      ? data.error.message
      : typeof data.error === "string"
        ? data.error
        : `Request failed (${res.status}).`;
  return new Error(message);
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
