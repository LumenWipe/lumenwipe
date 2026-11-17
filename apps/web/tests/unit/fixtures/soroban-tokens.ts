import type { SorobanTokenBalance, SorobanTokensResult } from "@lumenwipe/types";

/** A complete token discovery that confirmed exactly these balances. */
export function sorobanTokensOf(tokens: SorobanTokenBalance[]): SorobanTokensResult {
  return { tokens, unreadable: [], coverage: [], eventsScanned: null, warnings: [] };
}
