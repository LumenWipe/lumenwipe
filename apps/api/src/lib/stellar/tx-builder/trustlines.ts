import { TransactionBuilder, Operation, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { ClaimableBalance, Trustline } from "@lumenwipe/types";
import { assetToSdkAsset } from "@/lib/utils/assets";

export function trustlineRemovalOps(trustlines: Trustline[]): xdr.Operation[] {
  // Setting limit to "0" removes the trustline.
  return trustlines.map((tl) =>
    Operation.changeTrust({ asset: assetToSdkAsset(tl.asset), limit: "0" })
  );
}

/**
 * Adds a trustline for each balance's asset ahead of claiming it (the claim-remediation path:
 * a balance for an asset the account does not yet hold). The limit is omitted, which the SDK
 * defaults to its maximum - simpler and safer than computing a limit from the claimed amount.
 */
export function trustlineAddForClaimOps(balances: ClaimableBalance[]): xdr.Operation[] {
  // One op per ASSET, not per balance: several claimable balances can share an asset, and a
  // trustline is added once. The duplicate op was a harmless no-op on-chain but doubled the
  // operation count, the fee, and what the consent surface said the transaction does.
  const assets = [...new Set(balances.map((b) => b.asset))];
  return assets.map((asset) => Operation.changeTrust({ asset: assetToSdkAsset(asset) }));
}

export function buildRemoveTrustlinesTx(
  sdkAccount: Account,
  trustlines: Trustline[],
  network: Network
): string {
  const ops = trustlineRemovalOps(trustlines);
  // Per-operation fee: TransactionBuilder multiplies this by the operation count itself, so
  // pre-multiplying here would double-count it (BASE_FEE_STROOPS * N passed in, then * N again
  // by the SDK, charging N^2 instead of N).
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  }).setTimeout(TX_TIMEOUT_SECONDS);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}
