import { exitExpectations, verifyCloseTransaction as verifyClose } from "@lumenwipe/verify";
import type { AccountState, CloseTransaction, DecisionAnswer, DecisionPoint } from "@lumenwipe/sdk";
import type { ExampleNetwork } from "./support";

export interface CloseExpectation {
  /** The account read the user reviewed before the close: source, balance, signers, positions. */
  account: AccountState;
  /** The destination the user typed. */
  destination: string;
  network: ExampleNetwork;
  /** The deposit memo the user typed, for an exchange destination. None when omitted. */
  memo?: { value: string; type: "text" | "id" };
}

const DESTINATION_ACK_CHOICE = "i_control_this_address";

export const destinationDecisionId = (address: string): string => `destination:${address}`;

/**
 * Checks every transaction with `@lumenwipe/verify`, the verifier the LumenWipe web app signs
 * with, against the caller's own inputs and the account read, never against the API's `intent`
 * summary. These examples make no per-asset choices, so those inputs are empty: any transfer or
 * conversion the API added is refused rather than signed, and so is any memo other than the one
 * the caller passed.
 */
export function verifyCloseTransaction(tx: CloseTransaction, expected: CloseExpectation): void {
  if (tx.needsSponsoredFee) {
    throw new Error("This example does not handle fee-sponsored transactions.");
  }
  const { account, destination, network, memo } = expected;
  verifyClose({
    unsignedXdr: tx.xdr,
    network,
    expected: {
      source: account.address,
      destination,
      nativeBalance: account.nativeBalanceLumens,
      memo: memo?.value ?? null,
      memoType: memo?.type ?? null,
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
 * Answers the one decision these examples can make on its own: acknowledging a destination it
 * controls, and only when the plan asks (it does not for a listed exchange, which is never an
 * address the caller controls). Anything else the plan requires is a choice about the user's
 * assets, so it stops the run instead of guessing.
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
  return decisionPoints.some((dp) => dp.id === destinationId)
    ? [{ id: destinationId, choice: DESTINATION_ACK_CHOICE }]
    : [];
}
