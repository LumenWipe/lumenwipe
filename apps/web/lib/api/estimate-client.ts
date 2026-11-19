import type { Network } from "@/config/networks";
import { formatNumber, TWO_DECIMALS } from "@/lib/i18n/format";
import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { HERO } from "@/lib/i18n/messages/hero";
import type { RecoveryRange } from "@/lib/plan/expected-receive";

/** The estimate route's answer: derived figures and when the account was read, nothing else. */
export interface RecoveryEstimate {
  /** ISO time the account and its plan were read. */
  readAt: string;
  range: RecoveryRange;
}

/** Why an estimate failed, which the visitor reads in their own language. */
export type EstimateFailure = "invalid" | "missing" | "limited" | "unreadable";

/** A failed estimate, with text written for the visitor. */
export class EstimateError extends Error {
  readonly reason: EstimateFailure;

  constructor(reason: EstimateFailure) {
    super(HERO[SITE_LOCALE].estimate.errors[reason]);
    this.name = "EstimateError";
    this.reason = reason;
  }
}

/** One reason per status the route answers with; the route's own text is never shown. */
const FAILURES: Record<number, EstimateFailure> = {
  400: "invalid",
  404: "missing",
  429: "limited",
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
    throw new EstimateError("unreadable");
  });
  if (!res.ok) throw new EstimateError(FAILURES[res.status] ?? "unreadable");
  const body: unknown = await res.json().catch(() => null);
  if (!isEstimate(body)) throw new EstimateError("unreadable");
  return body;
}

/** Stroops as XLM rounded down to two decimals, so a shown figure never rounds up. */
export function formatXlmDown(stroops: string, locale: Locale = SITE_LOCALE): string {
  // Whole cents stay exact as a float for any XLM amount the network can hold.
  const cents = BigInt(stroops) / BigInt(100_000);
  return formatNumber(locale, Number(cents) / 100, TWO_DECIMALS);
}
