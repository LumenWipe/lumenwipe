import { TransactionBuilder, Operation, Asset, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { OpenOffer } from "@/types/account";
import { assetToSdkAsset } from "@/lib/utils/assets";

export function offerCancellationOps(offers: OpenOffer[]): xdr.Operation[] {
  // Setting amount to "0" cancels the offer.
  return offers.map((offer) =>
    Operation.manageSellOffer({
      selling: assetToSdkAsset(offer.selling),
      buying: assetToSdkAsset(offer.buying),
      amount: "0",
      price: offer.price || "1",
      offerId: offer.id,
    })
  );
}

export function buildCancelOffersTx(
  sdkAccount: Account,
  offers: OpenOffer[],
  network: Network
): string {
  const ops = offerCancellationOps(offers);
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS * offers.length),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  }).setTimeout(TX_TIMEOUT_SECONDS);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}
