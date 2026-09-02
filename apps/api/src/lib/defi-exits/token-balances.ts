import { Asset } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { xlmToStroops } from "@/lib/utils/amounts";

/**
 * What the account holds of each token, keyed the way a contract names it: by the Stellar Asset
 * Contract address. Native XLM and every classic trustline balance have one; a repay that needs
 * USDC looks it up by USDC's SAC id, the same address Blend's reserve carries.
 *
 * Amounts are base units (stroops for every classic asset, which all carry 7 decimals). A
 * trustline that is not authorized cannot be spent, so it is omitted rather than listed - the
 * adapter then reports the balance as unknown instead of pretending to zero.
 */
export function tokenBalancesFor(accountState: AccountState): Record<string, string> {
  const passphrase = NETWORK_PASSPHRASES[accountState.network];
  const balances: Record<string, string> = {
    [Asset.native().contractId(passphrase)]: xlmToStroops(accountState.nativeBalanceLumens),
  };
  for (const trustline of accountState.trustlines) {
    if (!trustline.authorized) continue;
    const contract = new Asset(trustline.code, trustline.issuer).contractId(passphrase);
    balances[contract] = xlmToStroops(trustline.balance);
  }
  return balances;
}
