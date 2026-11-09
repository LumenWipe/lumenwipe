import { Asset, Operation, type xdr } from "@stellar/stellar-sdk";
import { PERSISTENT_ASSETS, STANDING_LIQUIDITY_PRICE, type AssetCode } from "./scenarios";

// Pure, with no server-only import, so the e2e server can post the same offers for its per-run
// market maker that the reaper keeps refilled on the hosted one.

/** XLM the market maker keeps out of its standing offers, for its reserves and fees. */
export const MM_KEEP_XLM = 50;
/** Most XLM one standing offer sells; a session converts at most a few XLM of it. */
const STANDING_OFFER_MAX_XLM = 1000;
/** An offer worn below this is posted again at full size. */
const STANDING_OFFER_REFILL_XLM = 100;

export interface HorizonOffer {
  id: string;
  amount: string;
  selling: { asset_type: string };
  buying: { asset_code?: string; asset_issuer?: string };
}

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

/**
 * The operations that give each persistent asset a standing route to XLM: the market maker trusts
 * the asset and sells XLM for it at STANDING_LIQUIDITY_PRICE. Pure, so a test can check which
 * operations a given market maker state needs. An offer worn below the refill mark is resized;
 * `unfunded` names the assets left without one because the market maker is short of XLM.
 */
export function standingLiquidityOps(
  issuerPublic: string,
  nativeBalance: number,
  balances: readonly HorizonBalance[],
  offers: readonly HorizonOffer[]
): { ops: xdr.Operation[]; unfunded: AssetCode[] } {
  const ops: xdr.Operation[] = [];
  const unfunded: AssetCode[] = [];
  let spendable = nativeBalance - MM_KEEP_XLM;
  for (const code of PERSISTENT_ASSETS) {
    const asset = new Asset(code, issuerPublic);
    const trusted = balances.some((b) => b.asset_code === code && b.asset_issuer === issuerPublic);
    if (!trusted) ops.push(Operation.changeTrust({ asset }));
    const offer = offers.find(
      (o) =>
        o.selling.asset_type === "native" &&
        o.buying.asset_code === code &&
        o.buying.asset_issuer === issuerPublic
    );
    if (offer && Number(offer.amount) >= STANDING_OFFER_REFILL_XLM) continue;
    const amount = Math.min(spendable, STANDING_OFFER_MAX_XLM);
    if (amount < STANDING_OFFER_REFILL_XLM) {
      unfunded.push(code);
      continue;
    }
    spendable -= amount;
    ops.push(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: asset,
        amount: amount.toFixed(7),
        price: STANDING_LIQUIDITY_PRICE,
        ...(offer && { offerId: offer.id }),
      })
    );
  }
  return { ops, unfunded };
}
