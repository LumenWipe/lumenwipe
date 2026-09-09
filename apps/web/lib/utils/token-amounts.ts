/** The widest `decimals` a token is allowed to claim; SEP-41 tokens use 7, a few use 18. Mirrors
 *  apps/api/src/lib/utils/token-amounts.ts - duplicated, not imported, per the web/API boundary
 *  lint (CLAUDE.md): the web holds no transaction-building logic, but this is pure display math. */
export const MAX_TOKEN_DECIMALS = 38;

/**
 * Base units rendered with the token's decimals: "250" for 2500000000 at 7 decimals. A token that
 * does not report decimals, or claims an absurd figure, is shown in raw units and says so - the
 * fallback string stands alone (no trailing "of a token name"), unlike the API's own copy of this
 * function, since this module's callers never append a token name directly after the amount.
 */
export function formatTokenAmount(balance: string, decimals: number | null): string {
  if (!/^\d+$/.test(balance)) return balance;
  if (
    decimals === null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return `${balance} base units`;
  }
  if (decimals === 0) return balance;
  const padded = balance.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
