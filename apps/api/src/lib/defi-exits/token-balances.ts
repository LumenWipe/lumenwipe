import { Asset } from "@stellar/stellar-sdk";
import type { AccountState, OpenOffer } from "@lumenwipe/types";
import {
  ACCOUNT_BASE_RESERVE_XLM,
  BASE_RESERVE_XLM,
  SOROBAN_EXIT_FEE_ESTIMATE_STROOPS,
} from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { xlmToStroops } from "@/lib/utils/amounts";

/** What open offers hold back of an asset: the ledger refuses to spend below it. */
function sellingLiabilities(offers: OpenOffer[], asset: string): bigint {
  let total = BigInt(0);
  for (const offer of offers) {
    if (offer.selling === asset) total += BigInt(xlmToStroops(offer.amount));
  }
  return total;
}

function spendable(balance: bigint, held: bigint): string {
  return (balance > held ? balance - held : BigInt(0)).toString();
}

/**
 * What the account can actually spend of each token, keyed the way a contract names it: by the
 * Stellar Asset Contract address. Native XLM and every classic trustline balance have one; a
 * repay that needs USDC looks it up by USDC's SAC id, the same address Blend's reserve carries.
 *
 * Spendable, not nominal: the exit round runs before offers are cancelled, so what an open offer
 * is selling is not available to a repay, and XLM below the minimum reserve (plus the fee of the
 * exit transaction itself) is not either. A repay sized from the nominal balance would pass the
 * adapter's check, fail in simulation, and block the close on every retry - the offers that
 * would free it are only cancelled once the exit round is done.
 *
 * Amounts are base units (stroops for every classic asset, which all carry 7 decimals). A
 * trustline that is not authorized cannot be spent, so it is omitted rather than listed - the
 * adapter then reports the balance as unknown instead of pretending to zero.
 */
export function tokenBalancesFor(accountState: AccountState): Record<string, string> {
  const passphrase = NETWORK_PASSPHRASES[accountState.network];
  const reserveStroops =
    BigInt(xlmToStroops(ACCOUNT_BASE_RESERVE_XLM.toFixed(7))) +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) *
      BigInt(accountState.numSubEntries + accountState.numSponsoring);
  const nativeHeld =
    reserveStroops +
    BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS) +
    sellingLiabilities(accountState.openOffers, "native");
  const balances: Record<string, string> = {
    [Asset.native().contractId(passphrase)]: spendable(
      BigInt(xlmToStroops(accountState.nativeBalanceLumens)),
      nativeHeld
    ),
  };
  for (const trustline of accountState.trustlines) {
    if (!trustline.authorized) continue;
    const contract = new Asset(trustline.code, trustline.issuer).contractId(passphrase);
    balances[contract] = spendable(
      BigInt(xlmToStroops(trustline.balance)),
      sellingLiabilities(accountState.openOffers, trustline.asset)
    );
  }
  return balances;
}
