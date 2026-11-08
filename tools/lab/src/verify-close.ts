import { exitExpectations, verifyCloseTransaction } from "@lumenwipe/verify";
import type { AccountState, CloseTransaction } from "@lumenwipe/sdk";
import type { Network } from "./scenarios";

/**
 * Checks a transaction with `@lumenwipe/verify`, the verifier the web app signs with, against
 * the lab's own inputs and the account read. The lab makes no per-asset choices and sends no
 * memo, so any transfer, conversion or memo the API added is refused rather than signed.
 */
export function verifyLabClose(
  tx: CloseTransaction,
  account: AccountState,
  destination: string,
  network: Network
): void {
  if (tx.needsSponsoredFee) throw new Error("the lab does not sign fee-sponsored transactions");
  verifyCloseTransaction({
    unsignedXdr: tx.xdr,
    network,
    expected: {
      source: account.address,
      destination,
      nativeBalance: account.nativeBalanceLumens,
      memo: null,
      memoType: null,
      claimTrustlineAssets: [],
      accountSigners: account.signers,
      accountThresholds: account.thresholds,
      transfers: {},
      tokenTransfers: {},
      classicConversions: {},
      tokenConversions: {},
      ...exitExpectations(account, network),
    },
  });
}
