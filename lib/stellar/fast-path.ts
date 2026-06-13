import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import { fetchConversionPath } from "@/lib/se-api/paths";

export interface AssetConvertibility {
  asset: string;
  code: string;
  balance: string;
  convertible: boolean;
}

/**
 * Reports, per balance-bearing trustline, whether a usable conversion path to XLM
 * exists. Resolves to an empty array when there is nothing to convert (no network
 * call). The authoritative re-quote happens later at transaction-build time; this
 * is the plan-time, per-asset gate that drives the preview's swap-or-return choice.
 */
export async function assessConversions(
  accountState: AccountState,
  network: Network
): Promise<AssetConvertibility[]> {
  const withBalance = accountState.trustlines.filter(
    (tl) => tl.authorized && parseFloat(tl.balance) > 0
  );
  return Promise.all(
    withBalance.map(async (tl) => {
      const path = await fetchConversionPath(tl.asset, tl.balance, network).catch(() => null);
      return { asset: tl.asset, code: tl.code, balance: tl.balance, convertible: path !== null };
    })
  );
}
