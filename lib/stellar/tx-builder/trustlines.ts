import { TransactionBuilder, Operation, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { Trustline } from "@/types/account";
import { assetToSdkAsset } from "@/lib/utils/assets";

export function trustlineRemovalOps(trustlines: Trustline[]): xdr.Operation[] {
  // Setting limit to "0" removes the trustline.
  return trustlines.map((tl) =>
    Operation.changeTrust({ asset: assetToSdkAsset(tl.asset), limit: "0" })
  );
}

export function buildRemoveTrustlinesTx(
  sdkAccount: Account,
  trustlines: Trustline[],
  network: Network
): string {
  const ops = trustlineRemovalOps(trustlines);
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS * trustlines.length),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  }).setTimeout(TX_TIMEOUT_SECONDS);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}
