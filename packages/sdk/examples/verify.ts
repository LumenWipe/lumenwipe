import { exitExpectations, verifyCloseTransaction as verifyClose } from "@lumenwipe/verify";
import type { AccountState, CloseTransaction, DecisionAnswer, DecisionPoint } from "@lumenwipe/sdk";
import type { ExampleNetwork } from "./support";

export interface CloseExpectation {
  /** The account read the user reviewed before the close: source, balance, signers, positions. */
  account: AccountState;
  /** The destination the user typed. */
  destination: string;
  network: ExampleNetwork;
}

const DESTINATION_ACK_CHOICE = "i_control_this_address";

export const destinationDecisionId = (address: string): string => `destination:${address}`;

/**
 * Checks every transaction with `@lumenwipe/verify`, the verifier the LumenWipe web app signs
 * with, against the caller's own inputs and the account read, never against the API's `intent`
 * summary. This example makes no per-asset choices and sets no memo, so those inputs are empty:
 * any transfer, conversion or memo the API added is refused rather than signed.
 */
export function verifyCloseTransaction(tx: CloseTransaction, expected: CloseExpectation): void {
  if (tx.needsSponsoredFee) {
    throw new Error("This example does not handle fee-sponsored transactions.");
  }
  const { account, destination, network } = expected;
  verifyClose({
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

/**
 * Answers the one decision this example can make on its own: acknowledging a destination it
 * controls. Anything else the plan requires is a choice about the user's assets, so it stops
 * the run instead of guessing.
 */
export function buildDecisions(
  decisionPoints: DecisionPoint[],
  destination: string
): DecisionAnswer[] {
  const destinationId = destinationDecisionId(destination);
  const unresolved = decisionPoints.filter((dp) => dp.required && dp.id !== destinationId);
  if (unresolved.length > 0) {
    throw new Error(
      `The plan needs decisions this example does not answer: ${unresolved.map((dp) => dp.id).join(", ")}.`
    );
  }
  return [{ id: destinationId, choice: DESTINATION_ACK_CHOICE }];
}
