import { TransactionBuilder, Operation, Asset, Account } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { Trustline } from "@/types/account";
import type { ConversionPath } from "@/types/plan";
import { assetToSdkAsset } from "@/lib/utils/assets";

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

  const sendAsset = assetToSdkAsset(trustline.asset);
  const destAsset = Asset.native();
  const intermediatePath = path.path.map((p) => assetToSdkAsset(p));

  builder.addOperation(
    Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount: trustline.balance,
      destination: sdkAccount.accountId(),
      destAsset,
      destMin: path.destMin,
      path: intermediatePath,
    })
  );

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

  const asset = assetToSdkAsset(trustline.asset);

  builder.addOperation(
    Operation.payment({
      destination: trustline.issuer,
      asset,
      amount: trustline.balance,
    })
  );

  return builder.build().toEnvelope().toXDR("base64");
}
