import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import { fetchConversionPath } from "@/lib/se-api/paths";

/**
 * Returns true if every trustline with a balance has a usable conversion path,
 * so the whole close can be fused into one transaction. Returns true immediately
 * when there is nothing to convert. The authoritative re-quote happens later at
 * transaction-build time; this is the plan-time gate.
 */
export async function assessConversionsClean(
  accountState: AccountState,
  network: Network
): Promise<boolean> {
  const convertible = accountState.trustlines.filter((tl) => parseFloat(tl.balance) > 0);
  if (convertible.length === 0) return true;

  const results = await Promise.all(
    convertible.map((tl) => fetchConversionPath(tl.asset, tl.balance, network).catch(() => null))
  );
  return results.every((path) => path !== null);
}
