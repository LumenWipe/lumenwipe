import { TransactionBuilder, Operation, Asset, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { Trustline, ConversionPath } from "@lumenwipe/types";
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

/**
 * Pays the whole trustline balance to an account the caller chose, keeping the asset as the
 * asset instead of swapping or burning it.
 *
 * Structurally this is `issuerPaymentOp` with a destination that is not the issuer, and that one
 * difference is the entire security story: the issuer is derivable from the asset, so a payment
 * to it cannot be redirected, while this destination is arbitrary and is therefore exactly the
 * shape a compromised API would use to divert funds. Nothing here can tell the difference - the
 * browser's `verify()` is what binds this destination to the user's own choice before signing
 * (#112), and until it does, a transaction carrying this operation cannot be signed at all.
 *
 * The amount is the full balance, never a parameter. The `ChangeTrust` that removes the
 * trustline is emitted right after and fails on a non-zero balance, so a partial transfer would
 * strand the close midway with the account still open.
 */
export function transferPaymentOp(trustline: Trustline, destination: string): xdr.Operation {
  return Operation.payment({
    destination,
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
