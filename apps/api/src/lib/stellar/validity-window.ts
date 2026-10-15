import type { Transaction } from "@stellar/stellar-sdk";
import { MAX_SIGNED_VALIDITY_SECONDS } from "@/config/constants";

export type ValidityProblem = "unbounded" | "too_long" | "expired";

/** A server signature on an envelope with no expiry would stay usable indefinitely. */
export function validityProblem(tx: Transaction, now: Date): ValidityProblem | null {
  const maxTime = BigInt(tx.timeBounds?.maxTime ?? "0");
  if (maxTime === 0n) return "unbounded";
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (maxTime <= nowSeconds) return "expired";
  if (maxTime - nowSeconds > BigInt(MAX_SIGNED_VALIDITY_SECONDS)) return "too_long";
  return null;
}

export const VALIDITY_MESSAGES: Record<ValidityProblem, string> = {
  unbounded: `The transaction must expire within ${MAX_SIGNED_VALIDITY_SECONDS} seconds.`,
  too_long: `The transaction must expire within ${MAX_SIGNED_VALIDITY_SECONDS} seconds.`,
  expired: "The transaction has expired. Request a new one and sign it again.",
};
