import type { Network } from "@/config/networks";
import type { ConversionPath } from "@/types/plan";

// DEX path finding is not yet implemented.
//
// The Stellar classic SDEX requires Horizon's /paths/strict-send endpoint,
// which the team has decided not to use. We are evaluating a native
// integration with the Soroswap aggregator (soroswap.finance) as the
// preferred modern alternative — it routes across both the classic SDEX
// and Soroban AMM pools without depending on Horizon.
//
// Until that integration ships, asset conversion steps will surface a
// "no swap route available" warning that lets the user skip or return
// the balance to the issuer manually.
export async function fetchConversionPath(
  _fromAsset: string,
  _amount: string,
  _network: Network,
  _toAsset = "native"
): Promise<ConversionPath | null> {
  return null;
}
