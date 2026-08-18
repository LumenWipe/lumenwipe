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
  return balances.map((b) => Operation.changeTrust({ asset: assetToSdkAsset(b.asset) }));
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
