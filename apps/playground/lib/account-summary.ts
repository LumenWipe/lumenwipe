import type { AccountState } from "@lumenwipe/sdk";
import { BASE_RESERVE_XLM } from "./scenarios";

/**
 * The XLM the account's minimum balance holds: two base reserves for the account, one per
 * sub-entry and per entry it sponsors elsewhere, less one per entry another account pays for.
 */
export function lockedReserveXlm(
  state: Pick<AccountState, "numSubEntries" | "numSponsoring" | "numSponsored">
): number {
  const units = 2 + state.numSubEntries + state.numSponsoring - (state.numSponsored ?? 0);
  return units * BASE_RESERVE_XLM;
}
