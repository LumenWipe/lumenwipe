import { Asset } from "@stellar/stellar-sdk";
import type { AccountState, DefiPosition } from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";

/**
 * Every token contract an exit can pay into the account, per position. A pool pays out its own
 * tokens; a lending position pays out the asset it was supplied in. Read from the fields the
 * adapters themselves pass to the contract call, never from `display`, which is presentation
 * only and explicitly feeds nothing.
 *
 * Positions with no exit adapter are included anyway: they block the close rather than pay
 * anything out, so nothing arrives, and a decision asked about an asset that never shows up is
 * answered once and costs nothing. Missing the other direction is the expensive one.
 */
function payoutContracts(position: DefiPosition): string[] {
  switch (position.protocol) {
    case "blend":
      return [position.assetAddress];
    case "aquarius":
    case "soroswap":
      return [...(position.tokens ?? [])];
    default:
      // Phoenix and FxDAO carry no token addresses in their detected shape yet; when they gain
      // them, adding the case here is the whole change.
      return [];
  }
}

/**
 * The classic assets the account already trusts that a detected position's exit will pay into
 * it, by asset id ("CODE-ISSUER").
 *
 * This exists because of a dead-end the close had no other way out of. An asset arriving from an
 * exit is invisible to every other rule that decides what needs a disposition: it is not a
 * balance the account holds yet (a zero-balance trustline is skipped), and it is not a claimable
 * balance (which `claimedAmountsPerAsset` already covers). So an Aquarius LP of XLM/AQUA planned
 * cleanly, exited in round 1, paid AQUA into a trustline that had been empty - and round 2
 * refused to build anything, asking for a disposition the caller had never been shown, from a
 * screen with no way to give one.
 *
 * Matching is by Stellar Asset Contract id, which is what the pool names its tokens by, against
 * the trustlines the account holds. A SAC transfer to a G-address needs the trustline to exist,
 * so an asset that can arrive is always one already in this list.
 */
export function assetsArrivingFromExits(
  account: Pick<AccountState, "trustlines" | "network" | "defiPositions">
): Set<string> {
  const positions = account.defiPositions?.positions ?? [];
  if (positions.length === 0) return new Set();
  const payout = new Set(positions.flatMap(payoutContracts));
  if (payout.size === 0) return new Set();

  const passphrase = NETWORK_PASSPHRASES[account.network];
  const arriving = new Set<string>();
  for (const trustline of account.trustlines) {
    if (!trustline.authorized) continue;
    if (payout.has(new Asset(trustline.code, trustline.issuer).contractId(passphrase))) {
      arriving.add(trustline.asset);
    }
  }
  return arriving;
}

/**
 * What to price an arriving asset at when nothing holds it yet. Plan-time convertibility is a
 * gate - "is there a market at all" - and the authoritative quote is taken again at build time
 * against the amount that actually arrived, so probing with a nominal unit is honest here and
 * guessing the payout from a display string would not be.
 */
export const ARRIVING_ASSET_PROBE_AMOUNT = "1.0000000";
