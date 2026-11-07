import type { Network } from "@/config/networks";
import type { RecoveryRange } from "@/lib/plan/expected-receive";

/** The estimate route's answer: derived figures and when the account was read, nothing else. */
export interface RecoveryEstimate {
  /** ISO time the account and its plan were read. */
  readAt: string;
  range: RecoveryRange;
}

/** A failed estimate, with text written for the visitor. */
export class EstimateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateError";
  }
}

const UNREADABLE =
  "We couldn't read this account right now, so there is no estimate. Try again in a moment, or continue to close.";

/** One message per status the route answers with; the route's own text is never shown. */
const MESSAGES: Record<number, string> = {
  400: "Enter a valid Stellar account address.",
  404: "No account with this address exists on this network, so there is nothing to recover.",
  429: "Too many estimates from this connection today. You can still continue to close.",
};

const STROOPS = /^\d+$/;

function isEstimate(body: unknown): body is RecoveryEstimate {
  if (typeof body !== "object" || body === null) return false;
  const { readAt, range } = body as { readAt?: unknown; range?: Partial<RecoveryRange> };
  return (
    typeof readAt === "string" &&
    !Number.isNaN(Date.parse(readAt)) &&
    typeof range === "object" &&
    range !== null &&
    typeof range.lowStroops === "string" &&
    STROOPS.test(range.lowStroops) &&
    typeof range.highStroops === "string" &&
    STROOPS.test(range.highStroops) &&
    typeof range.blockers === "number"
  );
}

/**
 * Asks for the estimate of one address. The address goes in the body of a POST, so it is in no
 * URL the browser, a cache or analytics sees. Rejects with an `EstimateError` and never resolves
 * a figure it could not read: a failed read is a message, not a zero.
 */
export async function fetchEstimate(
  network: Network,
  address: string,
  signal?: AbortSignal
): Promise<RecoveryEstimate> {
  const res = await fetch(`/api/${network}/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
    cache: "no-store",
    signal,
  }).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    throw new EstimateError(UNREADABLE);
  });
  if (!res.ok) throw new EstimateError(MESSAGES[res.status] ?? UNREADABLE);
  const body: unknown = await res.json().catch(() => null);
  if (!isEstimate(body)) throw new EstimateError(UNREADABLE);
  return body;
}

/** Stroops as XLM rounded down to two decimals, so a shown figure never rounds up. */
export function formatXlmDown(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / BigInt(10_000_000);
  const cents = (value % BigInt(10_000_000)) / BigInt(100_000);
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
