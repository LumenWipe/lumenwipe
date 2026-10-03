import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { CloseTransaction, DecisionAnswer, DecisionPoint } from "@lumenwipe/sdk";

export interface CloseExpectation {
  source: string;
  destination: string;
}

const DESTINATION_ACK_CHOICE = "i_control_this_address";

export const destinationDecisionId = (address: string): string => `destination:${address}`;

/**
 * Decodes the XDR itself and checks it against the caller's own inputs, never against the API's
 * `intent` summary. It covers only what an account holding data entries, empty trustlines and
 * open offers needs; any other operation is rejected rather than signed.
 */
export function verifyCloseTransaction(tx: CloseTransaction, expected: CloseExpectation): void {
  if (tx.needsSponsoredFee) {
    throw new Error("This example does not handle fee-sponsored transactions.");
  }
  const parsed = TransactionBuilder.fromXDR(tx.xdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) {
    throw new Error("Unexpected fee-bump envelope.");
  }
  if (parsed.source !== expected.source) {
    throw new Error(`Transaction source ${parsed.source} is not the account being closed.`);
  }
  if (parsed.memo.type !== "none") {
    throw new Error("Unexpected memo on a close transaction.");
  }
  for (const op of parsed.operations) {
    if (op.source !== undefined && op.source !== expected.source) {
      throw new Error("An operation is sourced from a different account.");
    }
    switch (op.type) {
      case "manageData":
        if (op.value) throw new Error("A data entry operation writes instead of removes.");
        break;
      case "changeTrust":
        if (op.limit !== "0.0000000") throw new Error("A trustline operation does not remove it.");
        break;
      case "manageSellOffer":
        if (op.amount !== "0.0000000") throw new Error("An offer operation does not cancel it.");
        break;
      case "accountMerge":
        if (op.destination !== expected.destination) {
          throw new Error(`Merge targets ${op.destination}, not the requested destination.`);
        }
        break;
      default:
        throw new Error(`Unsupported operation in a close transaction: ${op.type}.`);
    }
  }
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
