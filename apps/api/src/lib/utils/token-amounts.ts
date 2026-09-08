/** The widest `decimals` a token is allowed to claim; SEP-41 tokens use 7, a few use 18. */
export const MAX_TOKEN_DECIMALS = 38;

/**
 * Base units rendered with the token's decimals: "250" for 2500000000 at 7 decimals. A token that
 * does not report decimals, or claims an absurd figure, is shown in raw units and says so.
 */
export function formatTokenAmount(balance: string, decimals: number | null): string {
  if (!/^\d+$/.test(balance)) return balance;
  if (
    decimals === null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return `${balance} base units of`;
  }
  if (decimals === 0) return balance;
  const padded = balance.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
