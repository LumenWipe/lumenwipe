import { StrKey } from "@stellar/stellar-sdk";

/** Contracts a caller may name by hand per request; more than this is a list, not a hint. */
export const MAX_MANUAL_TOKEN_CONTRACTS = 20;

/**
 * Parses a comma-separated list of Soroban contract addresses from a query string. Absent or
 * empty means none; a malformed entry or too many make the whole value invalid (null) rather
 * than silently dropping what the caller typed, since a dropped contract is a balance never
 * checked.
 */
export function parseTokenContracts(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > MAX_MANUAL_TOKEN_CONTRACTS) return null;
  for (const p of parts) {
    if (!/^C[A-Z2-7]{55}$/.test(p) || !StrKey.isValidContract(p)) return null;
  }
  return [...new Set(parts)];
}
