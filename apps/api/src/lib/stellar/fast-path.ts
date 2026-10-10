import type { Network } from "@/config/networks";
import type { AccountState } from "@lumenwipe/types";
import { fetchConversionPath } from "@/lib/stellar/path-finding";

export interface AssetConvertibility {
  asset: string;
  code: string;
  balance: string;
  convertible: boolean;
  /** True when the price source did not answer; `convertible` is then not an answer. */
  priceSourceUnavailable: boolean;
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
      const result = await fetchConversionPath(tl.asset, tl.balance, network);
      return {
        asset: tl.asset,
        code: tl.code,
        balance: tl.balance,
        convertible: result.kind === "route",
        priceSourceUnavailable: result.kind === "unavailable",
      };
    })
  );
}
