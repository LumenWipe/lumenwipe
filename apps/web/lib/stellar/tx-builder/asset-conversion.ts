import { TransactionBuilder, Operation, Asset, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { Trustline } from "@/types/account";
import type { ConversionPath } from "@/types/plan";
import { assetToSdkAsset } from "@/lib/utils/assets";

export function assetConversionOp(
  accountId: string,
  trustline: Trustline,
  path: ConversionPath
): xdr.Operation {
  return Operation.pathPaymentStrictSend({
    sendAsset: assetToSdkAsset(trustline.asset),
    sendAmount: trustline.balance,
    destination: accountId,
    destAsset: Asset.native(),
    destMin: path.destMin,
    path: path.path.map((p) => assetToSdkAsset(p)),
  });
}

export function issuerPaymentOp(trustline: Trustline): xdr.Operation {
  return Operation.payment({
    destination: trustline.issuer,
    asset: assetToSdkAsset(trustline.asset),
    amount: trustline.balance,
  });
}

export function buildConvertAssetTx(
  sdkAccount: Account,
  trustline: Trustline,
  path: ConversionPath,
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS * 2),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  builder.addOperation(assetConversionOp(sdkAccount.accountId(), trustline, path));

  return builder.build().toEnvelope().toXDR("base64");
}

export function buildSendToIssuerTx(
  sdkAccount: Account,
  trustline: Trustline,
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  builder.addOperation(issuerPaymentOp(trustline));

  return builder.build().toEnvelope().toXDR("base64");
}
